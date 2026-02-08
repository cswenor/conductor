import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Truncate markdown to a short excerpt (first non-heading paragraph, max N chars). */
export function excerptMarkdown(md: string, maxLen = 200): string {
  const lines = md.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('---')) continue;
    if (trimmed.length > maxLen) return `${trimmed.slice(0, maxLen)}...`;
    return trimmed;
  }
  return md.slice(0, maxLen);
}
