/**
 * fetchRunDetail data-layer tests
 *
 * Validates that fetchRunDetail wires all shared-layer queries and
 * returns the expected shape — especially the agentInvocations field.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---- Mocks ----

const now = '2025-06-01T00:00:00Z';

const mockRun = {
  runId: 'run_test1',
  taskId: 'task_test1',
  projectId: 'proj_test1',
  repoId: 'repo_test1',
  phase: 'planning',
  step: 'planning',
  status: 'active',
  baseBranch: 'main',
  branch: '',
  startedAt: now,
  updatedAt: now,
};

const mockProject = { projectId: 'proj_test1', userId: 'user_1' };
const mockTask = {
  taskId: 'task_test1',
  githubTitle: 'Fix login bug',
  githubIssueNumber: 42,
  githubType: 'issue',
  githubState: 'open',
};
const mockRepo = {
  repoId: 'repo_test1',
  githubFullName: 'org/repo',
  githubOwner: 'org',
  githubName: 'repo',
};

const mockInvocations = [
  {
    agentInvocationId: 'ai_1',
    runId: 'run_test1',
    agent: 'planner',
    action: 'create_plan',
    status: 'failed',
    tokensInput: 500,
    tokensOutput: 200,
    durationMs: 3000,
    errorCode: 'auth_error',
    errorMessage: 'Token expired',
    startedAt: now,
    completedAt: now,
  },
];

const mockGetRun = vi.fn().mockReturnValue(mockRun);
const mockGetTask = vi.fn().mockReturnValue(mockTask);
const mockGetProject = vi.fn().mockReturnValue(mockProject);
const mockGetRepo = vi.fn().mockReturnValue(mockRepo);
const mockCanAccessProject = vi.fn().mockReturnValue(true);
const mockListRunEvents = vi.fn().mockReturnValue([]);
const mockDeriveGateState = vi.fn().mockReturnValue({});
const mockListGateEvaluations = vi.fn().mockReturnValue([]);
const mockListOperatorActions = vi.fn().mockReturnValue([]);
const mockListAgentInvocations = vi.fn().mockReturnValue(mockInvocations);
const mockGetRunGateConfig = vi.fn().mockReturnValue({ requiredGates: [], optionalGates: [] });

vi.mock('@conductor/shared', () => ({
  getRun: (...args: unknown[]) => mockGetRun(...args) as unknown,
  getTask: (...args: unknown[]) => mockGetTask(...args) as unknown,
  getProject: (...args: unknown[]) => mockGetProject(...args) as unknown,
  getRepo: (...args: unknown[]) => mockGetRepo(...args) as unknown,
  canAccessProject: (...args: unknown[]) => mockCanAccessProject(...args) as unknown,
  listRunEvents: (...args: unknown[]) => mockListRunEvents(...args) as unknown,
  deriveGateState: (...args: unknown[]) => mockDeriveGateState(...args) as unknown,
  listGateEvaluations: (...args: unknown[]) => mockListGateEvaluations(...args) as unknown,
  listOperatorActions: (...args: unknown[]) => mockListOperatorActions(...args) as unknown,
  listAgentInvocations: (...args: unknown[]) => mockListAgentInvocations(...args) as unknown,
  getRunGateConfig: (...args: unknown[]) => mockGetRunGateConfig(...args) as unknown,
}));

// ---- Import after mocks ----

const { fetchRunDetail } = await import('./run-detail');

const fakeDb = {} as never;
const fakeUser = {
  id: 'user_1',
  userId: 'user_1',
  githubId: 42,
  githubLogin: 'testuser',
  githubNodeId: 'MDQ_42',
  githubName: 'Test User',
  githubAvatarUrl: null,
};

describe('fetchRunDetail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetRun.mockReturnValue(mockRun);
    mockGetProject.mockReturnValue(mockProject);
    mockCanAccessProject.mockReturnValue(true);
    mockGetTask.mockReturnValue(mockTask);
    mockGetRepo.mockReturnValue(mockRepo);
    mockListAgentInvocations.mockReturnValue(mockInvocations);
    mockGetRunGateConfig.mockReturnValue({ requiredGates: [], optionalGates: [] });
  });

  it('returns null when run does not exist', () => {
    mockGetRun.mockReturnValue(null);
    expect(fetchRunDetail(fakeDb, fakeUser, 'run_missing')).toBeNull();
  });

  it('returns null when user cannot access project', () => {
    mockCanAccessProject.mockReturnValue(false);
    expect(fetchRunDetail(fakeDb, fakeUser, 'run_test1')).toBeNull();
  });

  it('includes agentInvocations in result', () => {
    const result = fetchRunDetail(fakeDb, fakeUser, 'run_test1');
    expect(result).not.toBeNull();
    expect(result?.agentInvocations).toEqual(mockInvocations);
  });

  it('calls listAgentInvocations with the run ID', () => {
    fetchRunDetail(fakeDb, fakeUser, 'run_test1');
    expect(mockListAgentInvocations).toHaveBeenCalledWith(fakeDb, 'run_test1');
  });

  it('returns empty agentInvocations when none exist', () => {
    mockListAgentInvocations.mockReturnValue([]);
    const result = fetchRunDetail(fakeDb, fakeUser, 'run_test1');
    expect(result?.agentInvocations).toEqual([]);
  });

  it('returns all expected fields in the result shape', () => {
    const result = fetchRunDetail(fakeDb, fakeUser, 'run_test1');
    expect(result).not.toBeNull();
    expect(result).toHaveProperty('run');
    expect(result).toHaveProperty('task');
    expect(result).toHaveProperty('repo');
    expect(result).toHaveProperty('events');
    expect(result).toHaveProperty('gates');
    expect(result).toHaveProperty('gateEvaluations');
    expect(result).toHaveProperty('operatorActions');
    expect(result).toHaveProperty('agentInvocations');
    expect(result).toHaveProperty('requiredGates');
    expect(result).toHaveProperty('optionalGates');
  });

  it('sets task to null when task is missing', () => {
    mockGetTask.mockReturnValue(null);
    const result = fetchRunDetail(fakeDb, fakeUser, 'run_test1');
    expect(result?.task).toBeNull();
  });

  it('sets repo to null when repo is missing', () => {
    mockGetRepo.mockReturnValue(null);
    const result = fetchRunDetail(fakeDb, fakeUser, 'run_test1');
    expect(result?.repo).toBeNull();
  });
});
