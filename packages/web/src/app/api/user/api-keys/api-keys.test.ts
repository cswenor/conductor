/**
 * User API Keys Route Tests
 *
 * Tests GET, PUT, and DELETE handlers for API key management.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextResponse } from 'next/server';

// ---- Mocks ----

const mockListUserApiKeys = vi.fn();
const mockSetUserApiKey = vi.fn();
const mockDeleteUserApiKey = vi.fn();
const mockIsValidProvider = vi.fn();
const mockValidateApiKeyFormat = vi.fn();
const mockIsEncryptionInitialized = vi.fn();
const mockLogInfo = vi.fn();

vi.mock('@conductor/shared', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: (...args: unknown[]) => { mockLogInfo(...args); },
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  listUserApiKeys: (...args: unknown[]) => mockListUserApiKeys(...args) as unknown,
  setUserApiKey: (...args: unknown[]) => mockSetUserApiKey(...args) as unknown,
  deleteUserApiKey: (...args: unknown[]) => mockDeleteUserApiKey(...args) as unknown,
  isValidProvider: (...args: unknown[]) => mockIsValidProvider(...args) as unknown,
  validateApiKeyFormat: (...args: unknown[]) => mockValidateApiKeyFormat(...args) as unknown,
  isEncryptionInitialized: () => mockIsEncryptionInitialized() as unknown,
  PROVIDERS: [
    { id: 'anthropic', name: 'Anthropic', keyPrefix: 'sk-ant-', docUrl: 'https://console.anthropic.com/settings/keys' },
    { id: 'openai', name: 'OpenAI', keyPrefix: 'sk-', docUrl: 'https://platform.openai.com/api-keys' },
    { id: 'google', name: 'Google AI', keyPrefix: 'AIza', docUrl: 'https://aistudio.google.com/app/apikey' },
    { id: 'mistral', name: 'Mistral AI', keyPrefix: null, docUrl: 'https://console.mistral.ai/api-keys/' },
  ],
}));

vi.mock('@/lib/bootstrap', () => ({
  ensureBootstrap: vi.fn().mockResolvedValue(undefined),
  getDb: vi.fn().mockResolvedValue({}),
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

// ---- Import route after mocks ----

const { GET, PUT, DELETE: DELETE_HANDLER } = await import('./route');

// Response helpers
interface ProvidersBody {
  providers: Array<{ id: string; configured: boolean; lastFour: string | null }>;
  encryptionEnabled: boolean;
}

interface SuccessBody {
  success: boolean;
}

interface ErrorBody {
  error: string;
}

function createGetRequest(): Record<string, unknown> {
  return {
    cookies: { get: () => undefined },
    nextUrl: { pathname: '/api/user/api-keys', searchParams: new URLSearchParams() },
  };
}

function createPutRequest(body: Record<string, unknown>): Record<string, unknown> {
  return {
    cookies: { get: () => undefined },
    nextUrl: { pathname: '/api/user/api-keys' },
    json: () => Promise.resolve(body),
  };
}

function createDeleteRequest(provider?: string): Record<string, unknown> {
  const params = new URLSearchParams();
  if (provider !== undefined) {
    params.set('provider', provider);
  }
  return {
    cookies: { get: () => undefined },
    nextUrl: { pathname: '/api/user/api-keys', searchParams: params },
  };
}

// ---- Tests ----

describe('GET /api/user/api-keys', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListUserApiKeys.mockReturnValue([
      { provider: 'anthropic', configured: true, lastFour: 'abcd', updatedAt: '2025-01-01T00:00:00Z' },
    ]);
    mockIsEncryptionInitialized.mockReturnValue(true);
  });

  it('returns all 4 providers merged with configured status', async () => {
    const response = await GET(createGetRequest() as never, { params: Promise.resolve({}) } as never);
    const body = await response.json() as ProvidersBody;

    expect(body.providers).toHaveLength(4);
    expect(body.providers[0]?.id).toBe('anthropic');
    expect(body.providers[0]?.configured).toBe(true);
    expect(body.providers[0]?.lastFour).toBe('abcd');
    expect(body.providers[1]?.configured).toBe(false);
  });

  it('returns encryptionEnabled: true when encryption is initialized', async () => {
    mockIsEncryptionInitialized.mockReturnValue(true);

    const response = await GET(createGetRequest() as never, { params: Promise.resolve({}) } as never);
    const body = await response.json() as ProvidersBody;

    expect(body.encryptionEnabled).toBe(true);
  });

  it('returns encryptionEnabled: false when encryption is not initialized', async () => {
    mockIsEncryptionInitialized.mockReturnValue(false);

    const response = await GET(createGetRequest() as never, { params: Promise.resolve({}) } as never);
    const body = await response.json() as ProvidersBody;

    expect(body.encryptionEnabled).toBe(false);
  });

  it('sets Cache-Control: no-store header', async () => {
    const response = await GET(createGetRequest() as never, { params: Promise.resolve({}) } as never);

    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('PUT /api/user/api-keys', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsValidProvider.mockReturnValue(true);
    mockValidateApiKeyFormat.mockReturnValue(null);
  });

  it('returns 400 when provider is missing', async () => {
    const response = await PUT(
      createPutRequest({ apiKey: 'sk-ant-test-key-123456789' }) as never,
      { params: Promise.resolve({}) } as never
    );
    const body = await response.json() as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error).toContain('provider');
  });

  it('returns 400 when apiKey is missing', async () => {
    const response = await PUT(
      createPutRequest({ provider: 'anthropic' }) as never,
      { params: Promise.resolve({}) } as never
    );
    const body = await response.json() as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error).toContain('apiKey');
  });

  it('returns 400 for unsupported provider', async () => {
    mockIsValidProvider.mockReturnValue(false);

    const response = await PUT(
      createPutRequest({ provider: 'invalid', apiKey: 'sk-ant-test-key-123456789' }) as never,
      { params: Promise.resolve({}) } as never
    );
    const body = await response.json() as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error).toContain('Unsupported provider');
  });

  it('returns 400 with format error for invalid key', async () => {
    mockValidateApiKeyFormat.mockReturnValue('API key is too short');

    const response = await PUT(
      createPutRequest({ provider: 'anthropic', apiKey: 'bad' }) as never,
      { params: Promise.resolve({}) } as never
    );
    const body = await response.json() as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error).toBe('API key is too short');
  });

  it('returns success for valid key', async () => {
    const response = await PUT(
      createPutRequest({ provider: 'anthropic', apiKey: 'sk-ant-test-key-123456789' }) as never,
      { params: Promise.resolve({}) } as never
    );
    const body = await response.json() as SuccessBody;

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
  });

  it('calls setUserApiKey with correct arguments', async () => {
    await PUT(
      createPutRequest({ provider: 'anthropic', apiKey: 'sk-ant-test-key-123456789' }) as never,
      { params: Promise.resolve({}) } as never
    );

    expect(mockSetUserApiKey).toHaveBeenCalledWith(
      expect.anything(),
      'user_1',
      'anthropic',
      'sk-ant-test-key-123456789'
    );
  });

  it('never logs the raw API key', async () => {
    await PUT(
      createPutRequest({ provider: 'anthropic', apiKey: 'sk-ant-test-key-123456789' }) as never,
      { params: Promise.resolve({}) } as never
    );

    for (const call of mockLogInfo.mock.calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain('sk-ant-test-key-123456789');
    }
  });
});

describe('DELETE /api/user/api-keys', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsValidProvider.mockReturnValue(true);
  });

  it('returns success when key exists', async () => {
    mockDeleteUserApiKey.mockReturnValue(true);

    const response = await DELETE_HANDLER(
      createDeleteRequest('anthropic') as never,
      { params: Promise.resolve({}) } as never
    );
    const body = await response.json() as SuccessBody;

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
  });

  it('returns success when key does not exist (idempotent)', async () => {
    mockDeleteUserApiKey.mockReturnValue(false);

    const response = await DELETE_HANDLER(
      createDeleteRequest('anthropic') as never,
      { params: Promise.resolve({}) } as never
    );
    const body = await response.json() as SuccessBody;

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
  });

  it('returns 400 when provider query param is missing', async () => {
    const response = await DELETE_HANDLER(
      createDeleteRequest() as never,
      { params: Promise.resolve({}) } as never
    );
    const body = await response.json() as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error).toContain('provider');
  });

  it('returns 400 for unsupported provider', async () => {
    mockIsValidProvider.mockReturnValue(false);

    const response = await DELETE_HANDLER(
      createDeleteRequest('invalid') as never,
      { params: Promise.resolve({}) } as never
    );
    const body = await response.json() as ErrorBody;

    expect(response.status).toBe(400);
    expect(body.error).toContain('Unsupported provider');
  });
});
