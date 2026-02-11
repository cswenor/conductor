/**
 * GitHub Installations Route Tests
 *
 * Tests graceful fallback behavior for the installation discovery flow.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

// ---- Mocks ----

const mockPendingInstallations = [
  { installationId: 100, setupAction: 'install', state: null, userId: 'user_1', createdAt: '2025-01-01T00:00:00Z' },
];

const mockMergedInstallations = [
  { installationId: 100, setupAction: 'install', state: null, userId: 'user_1', createdAt: '2025-01-01T00:00:00Z' },
  { installationId: 200, setupAction: 'discovered', state: null, userId: 'user_1', createdAt: '2025-01-01T00:00:00Z' },
];

const mockListPendingInstallations = vi.fn().mockReturnValue(mockPendingInstallations);
const mockGetUserAccessToken = vi.fn<() => string | null>();
const mockSyncUserInstallations = vi.fn().mockReturnValue(mockMergedInstallations);
const mockGetInstallationOctokit = vi.fn();
const mockIsGitHubAppInitialized = vi.fn().mockReturnValue(false);
const mockInitGitHubApp = vi.fn();
const mockLogWarn = vi.fn();

vi.mock('@conductor/shared', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: mockLogWarn,
    error: vi.fn(),
    debug: vi.fn(),
  }),
  listPendingInstallations: (...args: unknown[]) => mockListPendingInstallations(...args) as unknown,
  getUserAccessToken: (...args: unknown[]) => mockGetUserAccessToken(...(args as [])) as unknown,
  syncUserInstallations: (...args: unknown[]) => mockSyncUserInstallations(...args) as unknown,
  getInstallationOctokit: (...args: unknown[]) => mockGetInstallationOctokit(...args) as unknown,
  isGitHubAppInitialized: () => mockIsGitHubAppInitialized() as unknown,
  initGitHubApp: (...args: unknown[]) => mockInitGitHubApp(...args) as unknown,
}));

vi.mock('@/lib/bootstrap', () => ({
  ensureBootstrap: vi.fn().mockResolvedValue(undefined),
  getDb: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/lib/config', () => ({
  getConfig: vi.fn().mockReturnValue({
    githubAppId: 'app-id',
    githubPrivateKey: 'private-key',
    githubWebhookSecret: 'webhook-secret',
  }),
}));

// Mock withAuth as pass-through injecting a fake user
vi.mock('@/lib/auth', () => ({
  withAuth: (handler: (req: unknown) => Promise<NextResponse>) => {
    return (req: unknown) => {
      (req as Record<string, unknown>)['user'] = {
        id: 'user_1',
        userId: 'user_1',
        githubId: 42,
        githubLogin: 'testuser',
        githubNodeId: 'MDQ_42',
        githubName: 'Test User',
        githubAvatarUrl: null,
      };
      return handler(req as never);
    };
  },
}));

// Mock @octokit/rest
const mockOctokitPaginate = vi.fn();

class MockOctokit {
  paginate = mockOctokitPaginate;
}

vi.mock('@octokit/rest', () => ({
  Octokit: MockOctokit,
}));

// ---- Import route after mocks ----

const { GET } = await import('./route');

// Response body shape
interface InstallationsBody {
  installations: Array<{ installationId: number; accountLogin: string }>;
  githubConfigured: boolean;
}

// Minimal request object
function createRequest(): Record<string, unknown> {
  return {
    cookies: { get: () => undefined },
    nextUrl: { pathname: '/api/github/installations' },
  };
}

async function getBody(response: NextResponse): Promise<InstallationsBody> {
  return (await response.json()) as InstallationsBody;
}

describe('GET /api/github/installations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListPendingInstallations.mockReturnValue(mockPendingInstallations);
    mockSyncUserInstallations.mockReturnValue(mockMergedInstallations);
    mockIsGitHubAppInitialized.mockReturnValue(false);
    mockGetInstallationOctokit.mockRejectedValue(new Error('not configured'));
  });

  it('returns pending-only when no user token', async () => {
    mockIsGitHubAppInitialized.mockReturnValue(true);
    mockGetUserAccessToken.mockReturnValue(null);

    const response = await GET(createRequest() as never, { params: Promise.resolve({}) } as never);
    const body = await getBody(response);

    expect(body.installations).toHaveLength(1);
    expect(body.installations[0]?.installationId).toBe(100);
    expect(body.githubConfigured).toBe(true);
    expect(mockSyncUserInstallations).not.toHaveBeenCalled();
  });

  it('returns pending-only when getUserAccessToken throws', async () => {
    mockIsGitHubAppInitialized.mockReturnValue(true);
    mockGetUserAccessToken.mockImplementation(() => {
      throw new Error('encryption not initialized');
    });

    const response = await GET(createRequest() as never, { params: Promise.resolve({}) } as never);
    const body = await getBody(response);

    expect(response.status).toBe(200);
    expect(body.installations).toHaveLength(1);
    expect(mockSyncUserInstallations).not.toHaveBeenCalled();
  });

  it('returns pending-only when GitHub API errors', async () => {
    mockIsGitHubAppInitialized.mockReturnValue(true);
    mockGetUserAccessToken.mockReturnValue('ghu_fake_token');
    mockOctokitPaginate.mockRejectedValue(new Error('Network error'));

    const response = await GET(createRequest() as never, { params: Promise.resolve({}) } as never);
    const body = await getBody(response);

    expect(response.status).toBe(200);
    expect(body.installations).toHaveLength(1);
    expect(mockSyncUserInstallations).not.toHaveBeenCalled();
  });

  it('merges discovered installations into response', async () => {
    mockIsGitHubAppInitialized.mockReturnValue(true);
    mockGetUserAccessToken.mockReturnValue('ghu_fake_token');
    mockOctokitPaginate.mockResolvedValue([
      { id: 200, account: { login: 'my-org', id: 999, node_id: 'MDQ_999', type: 'Organization' } },
    ]);

    const response = await GET(createRequest() as never, { params: Promise.resolve({}) } as never);
    const body = await getBody(response);

    expect(mockSyncUserInstallations).toHaveBeenCalledWith(
      expect.anything(),
      'user_1',
      [{ installationId: 200, accountLogin: 'my-org', accountId: 999, accountNodeId: 'MDQ_999', accountType: 'Organization' }]
    );
    expect(body.installations).toHaveLength(2);
    expect(body.githubConfigured).toBe(true);
  });

  it('returns githubConfigured: false when app not set up', async () => {
    mockIsGitHubAppInitialized.mockReturnValue(false);
    const { getConfig } = await import('@/lib/config');
    vi.mocked(getConfig).mockReturnValue({
      nodeEnv: 'development',
      version: '0.1.0',
      databasePath: './test.db',
      redisUrl: 'redis://localhost:6379',
      githubAppId: '',
      githubAppSlug: 'conductor',
      githubPrivateKey: '',
      githubWebhookSecret: '',
    });

    const response = await GET(createRequest() as never, { params: Promise.resolve({}) } as never);
    const body = await getBody(response);

    expect(body.githubConfigured).toBe(false);
    expect(mockGetUserAccessToken).not.toHaveBeenCalled();
  });

  it('logs scope hint on GitHub 403', async () => {
    mockIsGitHubAppInitialized.mockReturnValue(true);
    mockGetUserAccessToken.mockReturnValue('ghu_fake_token');
    const error403 = Object.assign(new Error('Forbidden'), { status: 403 });
    mockOctokitPaginate.mockRejectedValue(error403);

    const response = await GET(createRequest() as never, { params: Promise.resolve({}) } as never);
    const body = await getBody(response);

    expect(response.status).toBe(200);
    expect(body.installations).toHaveLength(1);
    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.stringContaining('read:org scope')
    );
  });
});
