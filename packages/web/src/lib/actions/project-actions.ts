'use server';

import { revalidatePath } from 'next/cache';
import {
  createLogger,
  getProject,
  deleteProject as sharedDeleteProject,
  canAccessProject,
} from '@conductor/shared';
import { getDb } from '@/lib/bootstrap';
import { requireServerUser } from '@/lib/auth/session';

const log = createLogger({ name: 'conductor:actions:project' });

interface ActionResult {
  success: boolean;
  error?: string;
}

export async function deleteProject(projectId: string): Promise<ActionResult> {
  try {
    const user = await requireServerUser();
    const db = await getDb();

    const existing = getProject(db, projectId);
    if (existing === null || !canAccessProject(user, existing)) {
      return { success: false, error: 'Project not found' };
    }

    const deleted = sharedDeleteProject(db, projectId);
    if (!deleted) {
      return { success: false, error: 'Project not found' };
    }

    log.info({ projectId, userId: user.userId }, 'Project deleted');
    revalidatePath('/projects');
    revalidatePath('/dashboard');
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to delete project';
    log.error({ projectId, error: msg }, 'deleteProject failed');
    return { success: false, error: msg };
  }
}
