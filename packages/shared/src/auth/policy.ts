/**
 * Authorization Policy Module
 *
 * Centralized authorization checks for resource access control.
 * Currently implements owner-only access; designed for extension to team roles in v0.3.
 */

import type { Project } from '../projects/index';

// =============================================================================
// Types
// =============================================================================

/**
 * Minimal user type for authorization checks.
 * Compatible with both shared User and web AuthenticatedRequest.user.
 */
export interface AuthUser {
  userId: string;
}

// =============================================================================
// Errors
// =============================================================================

/**
 * Thrown when a user attempts to access a resource they don't have permission for.
 * Handlers should catch this and return 404 (not 403) to avoid revealing resource existence.
 */
export class AuthorizationError extends Error {
  constructor(message = 'Access denied') {
    super(message);
    this.name = 'AuthorizationError';
  }
}

// =============================================================================
// Project Access Policies
// =============================================================================

/**
 * Check if a user can access a project.
 *
 * Current policy (v0.1): Owner-only access
 * Future policy (v0.3+): Owner OR team member access
 *
 * @param user - The authenticated user
 * @param project - The project to check access for
 * @returns true if user can access the project
 *
 * @example
 * ```typescript
 * if (!canAccessProject(request.user, project)) {
 *   return NextResponse.json({ error: 'Project not found' }, { status: 404 });
 * }
 * ```
 */
export function canAccessProject(user: AuthUser, project: Project): boolean {
  // v0.1: Owner-only access
  return project.userId === user.userId;

  // v0.3+: Extend to check project_members table
  // return project.userId === user.userId || isProjectMember(db, project.projectId, user.userId);
}

/**
 * Assert that a user can access a project, throwing AuthorizationError if not.
 *
 * @param user - The authenticated user
 * @param project - The project to check access for
 * @throws AuthorizationError if user cannot access the project
 *
 * @example
 * ```typescript
 * try {
 *   assertProjectAccess(request.user, project);
 * } catch (err) {
 *   if (err instanceof AuthorizationError) {
 *     return NextResponse.json({ error: 'Project not found' }, { status: 404 });
 *   }
 *   throw err;
 * }
 * ```
 */
export function assertProjectAccess(user: AuthUser, project: Project): void {
  if (!canAccessProject(user, project)) {
    throw new AuthorizationError('Project not found');
  }
}
