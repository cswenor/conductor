/**
 * Project Runs API
 *
 * Create and list runs for a project.
 */

import { NextResponse } from 'next/server';
import {
  createLogger,
  getProject,
  canAccessProject,
  createRun,
  listRuns,
  getTask,
  upsertTaskFromIssue,
  updateTaskActiveRun,
  type RunPhase,
} from '@conductor/shared';
import { ensureBootstrap, getDb, getQueues } from '@/lib/bootstrap';
import { withAuth, type AuthenticatedRequest } from '@/lib/auth';

const log = createLogger({ name: 'conductor:api:project-runs' });

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/projects/[id]/runs
 *
 * List runs for a project.
 * Protected: requires authentication.
 * Enforces ownership: user can only access their own projects.
 */
export const GET = withAuth(async (
  request: AuthenticatedRequest,
  { params }: RouteParams
): Promise<NextResponse> => {
  try {
    await ensureBootstrap();
    const db = await getDb();
    const { id: projectId } = await params;

    const project = getProject(db, projectId);
    if (project === null || !canAccessProject(request.user, project)) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      );
    }

    const url = new URL(request.url);
    const phase = url.searchParams.get('phase') as RunPhase | null;
    const limit = Number.parseInt(url.searchParams.get('limit') ?? '50', 10);
    const offset = Number.parseInt(url.searchParams.get('offset') ?? '0', 10);

    const runs = listRuns(db, {
      projectId,
      phase: phase ?? undefined,
      limit: Math.min(limit, 100),
      offset: Math.max(offset, 0),
    });

    return NextResponse.json({ runs });
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      'Failed to list runs'
    );
    return NextResponse.json(
      { error: 'Failed to list runs' },
      { status: 500 }
    );
  }
});

/**
 * POST /api/projects/[id]/runs
 *
 * Create a new run for a task in this project.
 * Protected: requires authentication.
 * Enforces ownership: user can only create runs in their own projects.
 *
 * Body:
 *   - taskId: string (existing task ID) OR
 *   - github: { nodeId, issueNumber, type, title, body, state, labelsJson } (upsert task from issue)
 *   - repoId: string (required)
 */
export const POST = withAuth(async (
  request: AuthenticatedRequest,
  { params }: RouteParams
): Promise<NextResponse> => {
  try {
    await ensureBootstrap();
    const db = await getDb();
    const queues = await getQueues();
    const { id: projectId } = await params;

    const project = getProject(db, projectId);
    if (project === null || !canAccessProject(request.user, project)) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      );
    }

    const body = await request.json() as {
      taskId?: string;
      repoId?: string;
      github?: {
        nodeId: string;
        issueNumber: number;
        type: string;
        title: string;
        body: string;
        state: string;
        labelsJson?: string;
      };
    };

    if (body.repoId === undefined) {
      return NextResponse.json(
        { error: 'Missing required field: repoId' },
        { status: 400 }
      );
    }

    // Resolve or create task
    let taskId: string;

    if (body.taskId !== undefined) {
      // Verify task exists and belongs to this project
      const task = getTask(db, body.taskId);
      if (task === null || task.projectId !== projectId) {
        return NextResponse.json(
          { error: 'Task not found' },
          { status: 404 }
        );
      }
      // Check no active run
      if (task.activeRunId !== undefined) {
        return NextResponse.json(
          { error: 'Task already has an active run' },
          { status: 409 }
        );
      }
      taskId = task.taskId;
    } else if (body.github !== undefined) {
      // Upsert task from GitHub issue fields
      const task = upsertTaskFromIssue(db, {
        projectId,
        repoId: body.repoId,
        githubNodeId: body.github.nodeId,
        githubIssueNumber: body.github.issueNumber,
        githubType: body.github.type,
        githubTitle: body.github.title,
        githubBody: body.github.body,
        githubState: body.github.state,
        githubLabelsJson: body.github.labelsJson ?? '[]',
      });
      // Check no active run
      if (task.activeRunId !== undefined) {
        return NextResponse.json(
          { error: 'Task already has an active run' },
          { status: 409 }
        );
      }
      taskId = task.taskId;
    } else {
      return NextResponse.json(
        { error: 'Must provide either taskId or github issue fields' },
        { status: 400 }
      );
    }

    // Create run in pending phase
    const run = createRun(db, {
      taskId,
      projectId,
      repoId: body.repoId,
      baseBranch: project.defaultBaseBranch ?? 'main',
    });

    // Set as active run for the task
    updateTaskActiveRun(db, taskId, run.runId);

    // Enqueue run job
    await queues.addJob('runs', `run:start:${run.runId}`, {
      runId: run.runId,
      action: 'start',
      triggeredBy: request.user.userId,
    });

    log.info(
      { runId: run.runId, taskId, projectId },
      'Run created'
    );

    return NextResponse.json({ run }, { status: 201 });
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      'Failed to create run'
    );
    return NextResponse.json(
      { error: 'Failed to create run' },
      { status: 500 }
    );
  }
});
