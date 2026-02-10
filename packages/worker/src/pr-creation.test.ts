import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Run } from '@conductor/shared';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const {
  mockGetRun,
  mockGetWorktreeForRun,
  mockGetRepo,
  mockResolveCredentials,
  mockExecFileSync,
} = vi.hoisted(() => ({
  mockGetRun: vi.fn(),
  mockGetWorktreeForRun: vi.fn(),
  mockGetRepo: vi.fn(),
  mockResolveCredentials: vi.fn(),
  mockExecFileSync: vi.fn(),
}));

vi.mock('@conductor/shared', () => ({
  getRun: mockGetRun,
  getWorktreeForRun: mockGetWorktreeForRun,
  getRepo: mockGetRepo,
  resolveCredentials: mockResolveCredentials,
  getDatabase: vi.fn(),
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

vi.mock('node:child_process', () => ({
  execFileSync: mockExecFileSync,
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
});
