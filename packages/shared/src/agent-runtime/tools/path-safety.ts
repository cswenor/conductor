/**
 * Path Safety Utilities
 *
 * Helpers for detecting symlink-based worktree escapes,
 * including when the target path does not yet exist.
 */

import { existsSync, realpathSync } from 'node:fs';
import { dirname, relative, isAbsolute } from 'node:path';

/**
 * Resolve a target path to its real filesystem location, even if
 * the final path component (or several) don't exist yet.
 *
 * Walks up dirname() to find the deepest existing ancestor,
 * resolves its realpath, then reattaches the non-existent suffix.
 *
 * Returns null if no ancestor exists (shouldn't happen in practice —
 * the root always exists).
 */
export function resolveRealTarget(targetPath: string): string | null {
  if (existsSync(targetPath)) {
    try {
      return realpathSync(targetPath);
    } catch {
      return null;
    }
  }

  // Walk up to find the deepest existing ancestor
  const suffixParts: string[] = [];
  let current = targetPath;

  while (current !== dirname(current)) {
    const parent = dirname(current);
    const basename = current.slice(parent.length).replace(/^[/\\]+/, '');
    suffixParts.unshift(basename);
    current = parent;

    if (existsSync(current)) {
      try {
        const realAncestor = realpathSync(current);
        // Reattach the suffix parts
        let result = realAncestor;
        for (const part of suffixParts) {
          result = result + '/' + part;
        }
        return result;
      } catch {
        return null;
      }
    }
  }

  return null;
}

/**
 * Check whether a resolved path escapes the worktree via symlinks.
 *
 * Returns a reason string if the path escapes, or null if safe.
 */
export function checkSymlinkEscape(resolvedPath: string, worktreePath: string): string | null {
  const realTarget = resolveRealTarget(resolvedPath);
  if (realTarget === null) {
    return null;
  }

  try {
    const realWorktree = realpathSync(worktreePath);
    const rel = relative(realWorktree, realTarget);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return `Path escapes worktree via symlink`;
    }
  } catch {
    // If worktree realpath fails, can't check — allow logical check to govern
  }

  return null;
}
