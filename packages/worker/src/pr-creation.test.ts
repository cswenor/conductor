import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Run } from '@conductor/shared';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const {
  mockGetRun,
  mockGetWorktreeForRun,
  mockGetRepo,
  mockGetTask,
  mockResolveCredentials,
  mockExecFileSync,
  mockListPullRequests,
  mockGetPullRequest,
  mockEnqueuePullRequest,
  mockProcessSingleWrite,
  mockGetWrite,
  mockResetStalledWrite,
  mockUpdateRunPrBundle,
  mockCasUpdateRunStep,
} = vi.hoisted(() => ({
  mockGetRun: vi.fn(),
  mockGetWorktreeForRun: vi.fn(),
  mockGetRepo: vi.fn(),
  mockGetTask: vi.fn(),
  mockResolveCredentials: vi.fn(),
  mockExecFileSync: vi.fn(),
  mockListPullRequests: vi.fn(),
  mockGetPullRequest: vi.fn(),
  mockEnqueuePullRequest: vi.fn(),
  mockProcessSingleWrite: vi.fn(),
  mockGetWrite: vi.fn(),
  mockResetStalledWrite: vi.fn(),
  mockUpdateRunPrBundle: vi.fn(),
  mockCasUpdateRunStep: vi.fn(),
}));

vi.mock('@conductor/shared', () => {
  const MockGitHubClient = class {
    listPullRequests = mockListPullRequests;
    getPullRequest = mockGetPullRequest;
  };
  return {
    getRun: mockGetRun,
    getWorktreeForRun: mockGetWorktreeForRun,
    getRepo: mockGetRepo,
    getTask: mockGetTask,
    resolveCredentials: mockResolveCredentials,
    getDatabase: vi.fn(),
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    GitHubClient: MockGitHubClient,
    enqueuePullRequest: mockEnqueuePullRequest,
    processSingleWrite: mockProcessSingleWrite,
    getWrite: mockGetWrite,
    resetStalledWrite: mockResetStalledWrite,
    updateRunPrBundle: mockUpdateRunPrBundle,
  };
});

vi.mock('node:child_process', () => ({
  execFileSync: mockExecFileSync,
}));

vi.mock('./run-helpers.ts', () => ({
  casUpdateRunStep: mockCasUpdateRunStep,
}));

// Import after mocks are set up
const { handlePrCreation } = await import('./pr-creation.ts');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const db = {} as ReturnType<typeof import('@conductor/shared').getDatabase>;
const mockMarkRunFailed = vi.fn();

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    runId: 'run_1',
    taskId: 'task_1',
    projectId: 'proj_1',
    repoId: 'repo_1',
    runNumber: 1,
    phase: 'awaiting_review',
    step: 'create_pr',
    policySetId: 'ps_1',
    lastEventSequence: 0,
    nextSequence: 1,
    baseBranch: 'main',
    branch: 'conductor/run_1',
    planRevisions: 0,
    testFixAttempts: 0,
    reviewRounds: 1,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeRepo() {
  return {
    repoId: 'repo_1',
    projectId: 'proj_1',
    githubNodeId: 'node_1',
    githubOwner: 'acme',
    githubName: 'widget',
    githubFullName: 'acme/widget',
    githubDefaultBranch: 'main',
    profileId: 'default',
    status: 'active' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeWorktree() {
  return {
    worktreeId: 'wt_1',
    runId: 'run_1',
    projectId: 'proj_1',
    repoId: 'repo_1',
    path: '/tmp/worktrees/run_1',
    branchName: 'conductor/run_1',
    baseCommit: 'abc123',
    status: 'active' as const,
    lastHeartbeatAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    destroyedAt: null,
  };
}

function makeTask() {
  return {
    taskId: 'task_1',
    projectId: 'proj_1',
    repoId: 'repo_1',
    githubNodeId: 'issue_node_1',
    githubIssueNumber: 42,
    githubType: 'issue',
    githubTitle: 'Add login page',
    githubBody: 'Please add a login page',
    githubState: 'open',
    githubLabelsJson: '[]',
    githubSyncedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
  };
}

function makePr(overrides: Record<string, unknown> = {}) {
  return {
    nodeId: 'PR_node_1',
    id: 100,
    number: 7,
    title: 'Add login page',
    body: 'Closes #42',
    state: 'open' as const,
    merged: false,
    htmlUrl: 'https://github.com/acme/widget/pull/7',
    head: { ref: 'conductor/run_1', sha: 'def456' },
    base: { ref: 'main' },
    user: { id: 1, login: 'bot' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    mergedAt: null,
    ...overrides,
  };
}

/** Set up all mocks for the "push succeeds" base scenario */
function setupPushSuccess() {
  mockGetRun.mockReturnValue(makeRun());
  mockGetWorktreeForRun.mockReturnValue(makeWorktree());
  mockGetRepo.mockReturnValue(makeRepo());
  mockResolveCredentials.mockResolvedValue({
    mode: 'github_installation',
    installationId: 42,
    token: 'ghs_secret123',
  });
  mockExecFileSync.mockReturnValue(Buffer.from(''));
  mockGetTask.mockReturnValue(makeTask());
  mockListPullRequests.mockResolvedValue([]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('handlePrCreation', () => {
  describe('phase/step guard', () => {
    it('skips push when run is null', async () => {
      mockGetRun.mockReturnValue(null);

      await handlePrCreation(db, makeRun(), mockMarkRunFailed);

      expect(mockMarkRunFailed).not.toHaveBeenCalled();
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('skips push when run is in a terminal phase (completed)', async () => {
      mockGetRun.mockReturnValue(makeRun({ phase: 'completed', step: 'create_pr' }));

      await handlePrCreation(db, makeRun(), mockMarkRunFailed);

      expect(mockMarkRunFailed).not.toHaveBeenCalled();
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('skips push when run phase is executing (stale job)', async () => {
      mockGetRun.mockReturnValue(makeRun({ phase: 'executing', step: 'implementer_apply_changes' }));

      await handlePrCreation(db, makeRun(), mockMarkRunFailed);

      expect(mockMarkRunFailed).not.toHaveBeenCalled();
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('skips push when run phase is blocked', async () => {
      mockGetRun.mockReturnValue(makeRun({ phase: 'blocked', step: 'create_pr' }));

      await handlePrCreation(db, makeRun(), mockMarkRunFailed);

      expect(mockMarkRunFailed).not.toHaveBeenCalled();
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('skips push when step is not create_pr', async () => {
      mockGetRun.mockReturnValue(makeRun({ phase: 'awaiting_review', step: 'reviewer_review_code' }));

      await handlePrCreation(db, makeRun(), mockMarkRunFailed);

      expect(mockMarkRunFailed).not.toHaveBeenCalled();
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });
  });

  describe('validation', () => {
    it('marks run failed when branch is empty', async () => {
      mockGetRun.mockReturnValue(makeRun({ branch: '' }));

      await handlePrCreation(db, makeRun(), mockMarkRunFailed);

      expect(mockMarkRunFailed).toHaveBeenCalledWith(db, 'run_1', 'No branch set on run');
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('marks run failed when worktree is null', async () => {
      mockGetRun.mockReturnValue(makeRun());
      mockGetWorktreeForRun.mockReturnValue(null);

      await handlePrCreation(db, makeRun(), mockMarkRunFailed);

      expect(mockMarkRunFailed).toHaveBeenCalledWith(db, 'run_1', 'No active worktree found for run');
    });

    it('marks run failed when repo is null', async () => {
      mockGetRun.mockReturnValue(makeRun());
      mockGetWorktreeForRun.mockReturnValue(makeWorktree());
      mockGetRepo.mockReturnValue(null);

      await handlePrCreation(db, makeRun(), mockMarkRunFailed);

      expect(mockMarkRunFailed).toHaveBeenCalledWith(db, 'run_1', 'Repository not found for run');
    });
  });

  describe('credential resolution', () => {
    it('marks run failed when credential mode is not github_installation', async () => {
      mockGetRun.mockReturnValue(makeRun());
      mockGetWorktreeForRun.mockReturnValue(makeWorktree());
      mockGetRepo.mockReturnValue(makeRepo());
      mockResolveCredentials.mockResolvedValue({ mode: 'none' });

      await handlePrCreation(db, makeRun(), mockMarkRunFailed);

      expect(mockMarkRunFailed).toHaveBeenCalledWith(db, 'run_1', 'Unexpected credential mode for create_pr step');
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });

    it('marks run failed when resolveCredentials throws', async () => {
      mockGetRun.mockReturnValue(makeRun());
      mockGetWorktreeForRun.mockReturnValue(makeWorktree());
      mockGetRepo.mockReturnValue(makeRepo());
      mockResolveCredentials.mockRejectedValue(new Error('boom'));

      await handlePrCreation(db, makeRun(), mockMarkRunFailed);

      expect(mockMarkRunFailed).toHaveBeenCalledWith(db, 'run_1', 'Failed to resolve credentials for PR creation');
      expect(mockExecFileSync).not.toHaveBeenCalled();
    });
  });

  describe('git push', () => {
    beforeEach(() => {
      mockGetRun.mockReturnValue(makeRun());
      mockGetWorktreeForRun.mockReturnValue(makeWorktree());
      mockGetRepo.mockReturnValue(makeRepo());
      mockResolveCredentials.mockResolvedValue({
        mode: 'github_installation',
        installationId: 42,
        token: 'ghs_secret123',
      });
    });

    it('pushes branch with correct args on success', async () => {
      mockExecFileSync.mockReturnValue(Buffer.from(''));
      mockGetTask.mockReturnValue(makeTask());
      mockListPullRequests.mockResolvedValue([]);
      mockEnqueuePullRequest.mockReturnValue({ githubWriteId: 'ghw_1', isNew: true, status: 'queued' });
      mockProcessSingleWrite.mockResolvedValue({
        githubWriteId: 'ghw_1', success: true,
        githubUrl: 'https://github.com/acme/widget/pull/7', nodeId: 'PR_node_1', number: 7,
      });
      mockUpdateRunPrBundle.mockReturnValue(true);
      mockCasUpdateRunStep.mockReturnValue(true);

      await handlePrCreation(db, makeRun(), mockMarkRunFailed);

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'git',
        ['push', 'https://x-access-token:ghs_secret123@github.com/acme/widget.git', 'conductor/run_1'],
        { cwd: '/tmp/worktrees/run_1', timeout: 60_000 }
      );
      expect(mockMarkRunFailed).not.toHaveBeenCalled();
    });

    it('marks run failed with safe message on push error', async () => {
      mockExecFileSync.mockImplementation(() => {
        throw new Error('fatal: could not push to https://x-access-token:ghs_secret123@github.com/acme/widget.git');
      });

      await handlePrCreation(db, makeRun(), mockMarkRunFailed);

      expect(mockMarkRunFailed).toHaveBeenCalledWith(db, 'run_1', 'Git push failed');
      // Verify the token/URL is NOT in the error message passed to markRunFailed
      const failedArgs = mockMarkRunFailed.mock.calls[0] as string[];
      expect(failedArgs[2]).not.toContain('ghs_secret123');
      expect(failedArgs[2]).not.toContain('x-access-token');
    });
  });

  describe('PR creation (WP10.3)', () => {
    describe('missing task', () => {
      it('marks run failed when task is null', async () => {
        setupPushSuccess();
        mockGetTask.mockReturnValue(null);

        await handlePrCreation(db, makeRun(), mockMarkRunFailed);

        expect(mockMarkRunFailed).toHaveBeenCalledWith(db, 'run_1', 'Task not found for run');
        expect(mockEnqueuePullRequest).not.toHaveBeenCalled();
      });
    });

    describe('idempotency (open PR exists on GitHub)', () => {
      it('backfills PR bundle and transitions step without creating new PR', async () => {
        setupPushSuccess();
        mockListPullRequests.mockResolvedValue([makePr()]);
        mockUpdateRunPrBundle.mockReturnValue(true);
        mockCasUpdateRunStep.mockReturnValue(true);

        await handlePrCreation(db, makeRun(), mockMarkRunFailed);

        expect(mockEnqueuePullRequest).not.toHaveBeenCalled();
        expect(mockUpdateRunPrBundle).toHaveBeenCalledWith(db, expect.objectContaining({
          runId: 'run_1',
          prNumber: 7,
          prNodeId: 'PR_node_1',
          prUrl: 'https://github.com/acme/widget/pull/7',
          prState: 'open',
        }));
        expect(mockCasUpdateRunStep).toHaveBeenCalledWith(db, 'run_1', 'awaiting_review', 'create_pr', 'wait_pr_merge');
        expect(mockMarkRunFailed).not.toHaveBeenCalled();
      });
    });

    describe('closed PR ignored', () => {
      it('proceeds to create new PR when no open PR found', async () => {
        setupPushSuccess();
        // listPullRequests(state:'open') returns empty
        mockListPullRequests.mockResolvedValue([]);
        mockEnqueuePullRequest.mockReturnValue({ githubWriteId: 'ghw_1', isNew: true, status: 'queued' });
        mockProcessSingleWrite.mockResolvedValue({
          githubWriteId: 'ghw_1', success: true,
          githubUrl: 'https://github.com/acme/widget/pull/8', nodeId: 'PR_node_2', number: 8,
        });
        mockUpdateRunPrBundle.mockReturnValue(true);
        mockCasUpdateRunStep.mockReturnValue(true);

        await handlePrCreation(db, makeRun(), mockMarkRunFailed);

        expect(mockEnqueuePullRequest).toHaveBeenCalled();
        expect(mockProcessSingleWrite).toHaveBeenCalled();
        expect(mockMarkRunFailed).not.toHaveBeenCalled();
      });
    });

    describe('happy path', () => {
      it('push → no existing PR → enqueue (isNew) → process → bundle → CAS', async () => {
        setupPushSuccess();
        mockEnqueuePullRequest.mockReturnValue({ githubWriteId: 'ghw_1', isNew: true, status: 'queued' });
        mockProcessSingleWrite.mockResolvedValue({
          githubWriteId: 'ghw_1', success: true,
          githubUrl: 'https://github.com/acme/widget/pull/7', nodeId: 'PR_node_1', number: 7,
        });
        mockUpdateRunPrBundle.mockReturnValue(true);
        mockCasUpdateRunStep.mockReturnValue(true);

        await handlePrCreation(db, makeRun(), mockMarkRunFailed);

        expect(mockEnqueuePullRequest).toHaveBeenCalledWith(expect.objectContaining({
          db,
          runId: 'run_1',
          owner: 'acme',
          repo: 'widget',
          repoNodeId: 'node_1',
          title: 'Add login page',
          body: 'Closes #42\n\nAdd login page',
          head: 'conductor/run_1',
          base: 'main',
        }));
        expect(mockProcessSingleWrite).toHaveBeenCalledWith(db, 'ghw_1', 42);
        expect(mockUpdateRunPrBundle).toHaveBeenCalledWith(db, expect.objectContaining({
          runId: 'run_1',
          prNumber: 7,
          prNodeId: 'PR_node_1',
          prUrl: 'https://github.com/acme/widget/pull/7',
          prState: 'open',
        }));
        expect(mockCasUpdateRunStep).toHaveBeenCalledWith(db, 'run_1', 'awaiting_review', 'create_pr', 'wait_pr_merge');
        expect(mockMarkRunFailed).not.toHaveBeenCalled();
      });
    });

    describe('outbox failure', () => {
      it('marks run failed when processSingleWrite returns success: false', async () => {
        setupPushSuccess();
        mockEnqueuePullRequest.mockReturnValue({ githubWriteId: 'ghw_1', isNew: true, status: 'queued' });
        mockProcessSingleWrite.mockResolvedValue({
          githubWriteId: 'ghw_1', success: false, error: 'Validation failed', retryable: false,
        });

        await handlePrCreation(db, makeRun(), mockMarkRunFailed);

        expect(mockMarkRunFailed).toHaveBeenCalledWith(db, 'run_1', 'PR creation failed: Validation failed');
        expect(mockUpdateRunPrBundle).not.toHaveBeenCalled();
      });
    });

    describe('PR write result missing metadata', () => {
      it('marks run failed when number is missing from write result', async () => {
        setupPushSuccess();
        mockEnqueuePullRequest.mockReturnValue({ githubWriteId: 'ghw_1', isNew: true, status: 'queued' });
        mockProcessSingleWrite.mockResolvedValue({
          githubWriteId: 'ghw_1', success: true,
          githubUrl: 'https://github.com/acme/widget/pull/7', nodeId: 'PR_node_1',
          // number is missing
        });

        await handlePrCreation(db, makeRun(), mockMarkRunFailed);

        expect(mockMarkRunFailed).toHaveBeenCalledWith(
          db, 'run_1',
          'PR creation succeeded but response is missing required metadata (number, nodeId, or URL)'
        );
        expect(mockUpdateRunPrBundle).not.toHaveBeenCalled();
      });

      it('marks run failed when nodeId is missing from write result', async () => {
        setupPushSuccess();
        mockEnqueuePullRequest.mockReturnValue({ githubWriteId: 'ghw_1', isNew: true, status: 'queued' });
        mockProcessSingleWrite.mockResolvedValue({
          githubWriteId: 'ghw_1', success: true,
          githubUrl: 'https://github.com/acme/widget/pull/7', number: 7,
          // nodeId is missing
        });

        await handlePrCreation(db, makeRun(), mockMarkRunFailed);

        expect(mockMarkRunFailed).toHaveBeenCalledWith(
          db, 'run_1',
          'PR creation succeeded but response is missing required metadata (number, nodeId, or URL)'
        );
        expect(mockUpdateRunPrBundle).not.toHaveBeenCalled();
      });
    });

    describe('PR bundle update failure', () => {
      it('marks run failed and does NOT transition step', async () => {
        setupPushSuccess();
        mockEnqueuePullRequest.mockReturnValue({ githubWriteId: 'ghw_1', isNew: true, status: 'queued' });
        mockProcessSingleWrite.mockResolvedValue({
          githubWriteId: 'ghw_1', success: true,
          githubUrl: 'https://github.com/acme/widget/pull/7', nodeId: 'PR_node_1', number: 7,
        });
        mockUpdateRunPrBundle.mockReturnValue(false);

        await handlePrCreation(db, makeRun(), mockMarkRunFailed);

        expect(mockMarkRunFailed).toHaveBeenCalledWith(db, 'run_1', 'Failed to update run PR bundle');
        expect(mockCasUpdateRunStep).not.toHaveBeenCalled();
      });
    });

    describe('CAS step fails (stale job)', () => {
      it('logs and returns without markRunFailed', async () => {
        setupPushSuccess();
        mockEnqueuePullRequest.mockReturnValue({ githubWriteId: 'ghw_1', isNew: true, status: 'queued' });
        mockProcessSingleWrite.mockResolvedValue({
          githubWriteId: 'ghw_1', success: true,
          githubUrl: 'https://github.com/acme/widget/pull/7', nodeId: 'PR_node_1', number: 7,
        });
        mockUpdateRunPrBundle.mockReturnValue(true);
        mockCasUpdateRunStep.mockReturnValue(false);

        await handlePrCreation(db, makeRun(), mockMarkRunFailed);

        expect(mockCasUpdateRunStep).toHaveBeenCalled();
        expect(mockMarkRunFailed).not.toHaveBeenCalled();
      });
    });

    describe('existing write — completed (crash recovery, open PR)', () => {
      it('uses stored githubNumber to fetch PR, backfills bundle', async () => {
        setupPushSuccess();
        mockEnqueuePullRequest.mockReturnValue({ githubWriteId: 'ghw_1', isNew: false, status: 'completed' });
        mockGetWrite.mockReturnValue({
          githubWriteId: 'ghw_1', status: 'completed',
          githubUrl: 'https://github.com/acme/widget/pull/7', githubId: 100, githubNumber: 7,
        });
        mockGetPullRequest.mockResolvedValue(makePr({ state: 'open', merged: false }));
        mockUpdateRunPrBundle.mockReturnValue(true);
        mockCasUpdateRunStep.mockReturnValue(true);

        await handlePrCreation(db, makeRun(), mockMarkRunFailed);

        expect(mockGetPullRequest).toHaveBeenCalledWith('acme', 'widget', 7);
        expect(mockUpdateRunPrBundle).toHaveBeenCalledWith(db, expect.objectContaining({
          prState: 'open',
          prNumber: 7,
        }));
        expect(mockCasUpdateRunStep).toHaveBeenCalled();
        expect(mockMarkRunFailed).not.toHaveBeenCalled();
        expect(mockProcessSingleWrite).not.toHaveBeenCalled();
      });

      it('falls back to URL parsing when githubNumber is missing (legacy write)', async () => {
        setupPushSuccess();
        mockEnqueuePullRequest.mockReturnValue({ githubWriteId: 'ghw_1', isNew: false, status: 'completed' });
        mockGetWrite.mockReturnValue({
          githubWriteId: 'ghw_1', status: 'completed',
          githubUrl: 'https://github.com/acme/widget/pull/7', githubId: 100,
          // githubNumber is undefined (legacy write before migration 016)
        });
        mockGetPullRequest.mockResolvedValue(makePr({ state: 'open', merged: false }));
        mockUpdateRunPrBundle.mockReturnValue(true);
        mockCasUpdateRunStep.mockReturnValue(true);

        await handlePrCreation(db, makeRun(), mockMarkRunFailed);

        expect(mockGetPullRequest).toHaveBeenCalledWith('acme', 'widget', 7);
        expect(mockMarkRunFailed).not.toHaveBeenCalled();
      });

      it('marks run failed when both githubNumber and URL are missing', async () => {
        setupPushSuccess();
        mockEnqueuePullRequest.mockReturnValue({ githubWriteId: 'ghw_1', isNew: false, status: 'completed' });
        mockGetWrite.mockReturnValue({
          githubWriteId: 'ghw_1', status: 'completed',
          githubUrl: null, githubId: 100,
          // githubNumber is undefined, githubUrl is null
        });

        await handlePrCreation(db, makeRun(), mockMarkRunFailed);

        expect(mockMarkRunFailed).toHaveBeenCalledWith(db, 'run_1', 'Cannot determine PR number from completed write');
        expect(mockGetPullRequest).not.toHaveBeenCalled();
      });
    });

    describe('existing write — completed (crash recovery, merged PR)', () => {
      it('backfills bundle with prState merged', async () => {
        setupPushSuccess();
        mockEnqueuePullRequest.mockReturnValue({ githubWriteId: 'ghw_1', isNew: false, status: 'completed' });
        mockGetWrite.mockReturnValue({
          githubWriteId: 'ghw_1', status: 'completed',
          githubUrl: 'https://github.com/acme/widget/pull/7', githubId: 100, githubNumber: 7,
        });
        mockGetPullRequest.mockResolvedValue(makePr({ state: 'closed', merged: true }));
        mockUpdateRunPrBundle.mockReturnValue(true);
        mockCasUpdateRunStep.mockReturnValue(true);

        await handlePrCreation(db, makeRun(), mockMarkRunFailed);

        expect(mockUpdateRunPrBundle).toHaveBeenCalledWith(db, expect.objectContaining({
          prState: 'merged',
        }));
        expect(mockMarkRunFailed).not.toHaveBeenCalled();
      });
    });

    describe('existing write — completed (crash recovery, closed PR)', () => {
      it('backfills bundle with prState closed', async () => {
        setupPushSuccess();
        mockEnqueuePullRequest.mockReturnValue({ githubWriteId: 'ghw_1', isNew: false, status: 'completed' });
        mockGetWrite.mockReturnValue({
          githubWriteId: 'ghw_1', status: 'completed',
          githubUrl: 'https://github.com/acme/widget/pull/7', githubId: 100, githubNumber: 7,
        });
        mockGetPullRequest.mockResolvedValue(makePr({ state: 'closed', merged: false }));
        mockUpdateRunPrBundle.mockReturnValue(true);
        mockCasUpdateRunStep.mockReturnValue(true);

        await handlePrCreation(db, makeRun(), mockMarkRunFailed);

        expect(mockUpdateRunPrBundle).toHaveBeenCalledWith(db, expect.objectContaining({
          prState: 'closed',
        }));
        expect(mockMarkRunFailed).not.toHaveBeenCalled();
      });
    });

    describe('existing write — queued/failed', () => {
      it('calls processSingleWrite for queued write', async () => {
        setupPushSuccess();
        mockEnqueuePullRequest.mockReturnValue({ githubWriteId: 'ghw_1', isNew: false, status: 'queued' });
        mockGetWrite.mockReturnValue({ githubWriteId: 'ghw_1', status: 'queued' });
        mockProcessSingleWrite.mockResolvedValue({
          githubWriteId: 'ghw_1', success: true,
          githubUrl: 'https://github.com/acme/widget/pull/7', nodeId: 'PR_node_1', number: 7,
        });
        mockUpdateRunPrBundle.mockReturnValue(true);
        mockCasUpdateRunStep.mockReturnValue(true);

        await handlePrCreation(db, makeRun(), mockMarkRunFailed);

        expect(mockProcessSingleWrite).toHaveBeenCalledWith(db, 'ghw_1', 42);
        expect(mockUpdateRunPrBundle).toHaveBeenCalled();
        expect(mockCasUpdateRunStep).toHaveBeenCalled();
        expect(mockMarkRunFailed).not.toHaveBeenCalled();
      });

      it('calls processSingleWrite for failed write', async () => {
        setupPushSuccess();
        mockEnqueuePullRequest.mockReturnValue({ githubWriteId: 'ghw_1', isNew: false, status: 'failed' });
        mockGetWrite.mockReturnValue({ githubWriteId: 'ghw_1', status: 'failed' });
        mockProcessSingleWrite.mockResolvedValue({
          githubWriteId: 'ghw_1', success: true,
          githubUrl: 'https://github.com/acme/widget/pull/7', nodeId: 'PR_node_1', number: 7,
        });
        mockUpdateRunPrBundle.mockReturnValue(true);
        mockCasUpdateRunStep.mockReturnValue(true);

        await handlePrCreation(db, makeRun(), mockMarkRunFailed);

        expect(mockProcessSingleWrite).toHaveBeenCalledWith(db, 'ghw_1', 42);
        expect(mockMarkRunFailed).not.toHaveBeenCalled();
      });
    });

    describe('existing write — processing (stalled, reset succeeds)', () => {
      it('resets stalled write and processes it', async () => {
        setupPushSuccess();
        mockEnqueuePullRequest.mockReturnValue({ githubWriteId: 'ghw_1', isNew: false, status: 'processing' });
        mockGetWrite.mockReturnValue({ githubWriteId: 'ghw_1', status: 'processing' });
        mockResetStalledWrite.mockReturnValue(true);
        mockProcessSingleWrite.mockResolvedValue({
          githubWriteId: 'ghw_1', success: true,
          githubUrl: 'https://github.com/acme/widget/pull/7', nodeId: 'PR_node_1', number: 7,
        });
        mockUpdateRunPrBundle.mockReturnValue(true);
        mockCasUpdateRunStep.mockReturnValue(true);

        await handlePrCreation(db, makeRun(), mockMarkRunFailed);

        expect(mockResetStalledWrite).toHaveBeenCalledWith(db, 'ghw_1');
        expect(mockProcessSingleWrite).toHaveBeenCalledWith(db, 'ghw_1', 42);
        expect(mockMarkRunFailed).not.toHaveBeenCalled();
      });
    });

    describe('existing write — processing (too recent, reset fails)', () => {
      it('calls scheduleRetry when provided', async () => {
        setupPushSuccess();
        mockEnqueuePullRequest.mockReturnValue({ githubWriteId: 'ghw_1', isNew: false, status: 'processing' });
        mockGetWrite.mockReturnValue({ githubWriteId: 'ghw_1', status: 'processing' });
        mockResetStalledWrite.mockReturnValue(false);
        const mockScheduleRetry = vi.fn().mockResolvedValue(undefined);

        await handlePrCreation(db, makeRun(), mockMarkRunFailed, mockScheduleRetry);

        expect(mockResetStalledWrite).toHaveBeenCalledWith(db, 'ghw_1');
        expect(mockScheduleRetry).toHaveBeenCalledWith('run_1', 30_000);
        expect(mockProcessSingleWrite).not.toHaveBeenCalled();
        expect(mockMarkRunFailed).not.toHaveBeenCalled();
      });

      it('throws when scheduleRetry is not provided (fallback)', async () => {
        setupPushSuccess();
        mockEnqueuePullRequest.mockReturnValue({ githubWriteId: 'ghw_1', isNew: false, status: 'processing' });
        mockGetWrite.mockReturnValue({ githubWriteId: 'ghw_1', status: 'processing' });
        mockResetStalledWrite.mockReturnValue(false);

        await expect(handlePrCreation(db, makeRun(), mockMarkRunFailed))
          .rejects.toThrow('PR write ghw_1 is in-flight for run run_1; retry later');

        expect(mockProcessSingleWrite).not.toHaveBeenCalled();
        expect(mockMarkRunFailed).not.toHaveBeenCalled();
      });
    });

    describe('existing write — cancelled (stale skip)', () => {
      it('logs and returns without markRunFailed', async () => {
        setupPushSuccess();
        mockEnqueuePullRequest.mockReturnValue({ githubWriteId: 'ghw_1', isNew: false, status: 'cancelled' });
        mockGetWrite.mockReturnValue({ githubWriteId: 'ghw_1', status: 'cancelled' });

        await handlePrCreation(db, makeRun(), mockMarkRunFailed);

        expect(mockProcessSingleWrite).not.toHaveBeenCalled();
        expect(mockMarkRunFailed).not.toHaveBeenCalled();
      });
    });

    describe('delayed retry chain (integration)', () => {
      it('first call schedules retry; second call (after stale) resets and succeeds', async () => {
        // --- Call 1: processing write, too recent to reset → scheduleRetry ---
        setupPushSuccess();
        mockEnqueuePullRequest.mockReturnValue({ githubWriteId: 'ghw_1', isNew: false, status: 'processing' });
        mockGetWrite.mockReturnValue({ githubWriteId: 'ghw_1', status: 'processing' });
        mockResetStalledWrite.mockReturnValue(false);
        const mockScheduleRetry = vi.fn().mockResolvedValue(undefined);

        await handlePrCreation(db, makeRun(), mockMarkRunFailed, mockScheduleRetry);

        expect(mockScheduleRetry).toHaveBeenCalledWith('run_1', 30_000);
        expect(mockProcessSingleWrite).not.toHaveBeenCalled();
        expect(mockMarkRunFailed).not.toHaveBeenCalled();

        // --- Call 2: simulates handleRunResume callback — write is now stale ---
        vi.clearAllMocks();
        setupPushSuccess();
        mockEnqueuePullRequest.mockReturnValue({ githubWriteId: 'ghw_1', isNew: false, status: 'processing' });
        mockGetWrite.mockReturnValue({ githubWriteId: 'ghw_1', status: 'processing' });
        mockResetStalledWrite.mockReturnValue(true); // now stale enough to reset
        mockProcessSingleWrite.mockResolvedValue({
          githubWriteId: 'ghw_1', success: true,
          githubUrl: 'https://github.com/acme/widget/pull/7', nodeId: 'PR_node_1', number: 7,
        });
        mockUpdateRunPrBundle.mockReturnValue(true);
        mockCasUpdateRunStep.mockReturnValue(true);

        await handlePrCreation(db, makeRun(), mockMarkRunFailed, mockScheduleRetry);

        expect(mockResetStalledWrite).toHaveBeenCalledWith(db, 'ghw_1');
        expect(mockProcessSingleWrite).toHaveBeenCalledWith(db, 'ghw_1', 42);
        expect(mockUpdateRunPrBundle).toHaveBeenCalledWith(db, expect.objectContaining({
          prNumber: 7,
          prNodeId: 'PR_node_1',
          prState: 'open',
        }));
        expect(mockCasUpdateRunStep).toHaveBeenCalledWith(db, 'run_1', 'awaiting_review', 'create_pr', 'wait_pr_merge');
        expect(mockMarkRunFailed).not.toHaveBeenCalled();
      });
    });
  });
});
