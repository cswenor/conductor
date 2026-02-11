/**
 * User API Keys Route
 *
 * CRUD operations for per-user AI provider API keys.
 * Never logs request bodies or raw key material.
 */

import { NextResponse } from 'next/server';
import {
  createLogger,
  listUserApiKeys,
  setUserApiKey,
  deleteUserApiKey,
  isValidProvider,
  validateApiKeyFormat,
  isEncryptionInitialized,
  PROVIDERS,
} from '@conductor/shared';
import { ensureBootstrap, getDb } from '@/lib/bootstrap';
import { withAuth, type AuthenticatedRequest } from '@/lib/auth';

const log = createLogger({ name: 'conductor:api:user-api-keys' });

/**
 * GET /api/user/api-keys
 *
 * List all providers with configured status for the authenticated user.
 * Returns provider metadata merged with key status and encryption state.
 */
export const GET = withAuth(async (request: AuthenticatedRequest): Promise<NextResponse> => {
  try {
    await ensureBootstrap();
    const db = await getDb();

    const keys = listUserApiKeys(db, request.user.userId);
    const encryptionEnabled = isEncryptionInitialized();

    const providers = PROVIDERS.map((provider) => {
      const key = keys.find((k) => k.provider === provider.id);
      return {
        ...provider,
        configured: key?.configured ?? false,
        lastFour: key?.lastFour ?? null,
        updatedAt: key?.updatedAt ?? null,
      };
    });

    return NextResponse.json(
      { providers, encryptionEnabled },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      'Failed to list API keys'
    );
    return NextResponse.json(
      { error: 'Failed to list API keys' },
      { status: 500 }
    );
  }
});

/**
 * PUT /api/user/api-keys
 *
 * Set or update an API key for a provider.
 * Body: { provider: string, apiKey: string }
 */
export const PUT = withAuth(async (request: AuthenticatedRequest): Promise<NextResponse> => {
  try {
    await ensureBootstrap();
    const db = await getDb();

    const body = await request.json() as Partial<{ provider: string; apiKey: string }>;

    if (body.provider === undefined || body.provider === '') {
      return NextResponse.json(
        { error: 'Missing required field: provider' },
        { status: 400 }
      );
    }

    if (body.apiKey === undefined || body.apiKey === '') {
      return NextResponse.json(
        { error: 'Missing required field: apiKey' },
        { status: 400 }
      );
    }

    if (!isValidProvider(body.provider)) {
      return NextResponse.json(
        { error: `Unsupported provider: ${body.provider}` },
        { status: 400 }
      );
    }

    const formatError = validateApiKeyFormat(body.provider, body.apiKey);
    if (formatError !== null) {
      return NextResponse.json(
        { error: formatError },
        { status: 400 }
      );
    }

    setUserApiKey(db, request.user.userId, body.provider, body.apiKey);

    log.info({ userId: request.user.userId, provider: body.provider }, 'API key updated');

    return NextResponse.json({ success: true });
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      'Failed to set API key'
    );
    return NextResponse.json(
      { error: 'Failed to set API key' },
      { status: 500 }
    );
  }
});

/**
 * DELETE /api/user/api-keys?provider=anthropic
 *
 * Remove an API key. Idempotent — always returns success
 * regardless of whether the key existed.
 */
export const DELETE = withAuth(async (request: AuthenticatedRequest): Promise<NextResponse> => {
  try {
    await ensureBootstrap();
    const db = await getDb();

    const provider = request.nextUrl.searchParams.get('provider');

    if (provider === null || provider === '') {
      return NextResponse.json(
        { error: 'Missing required query parameter: provider' },
        { status: 400 }
      );
    }

    if (!isValidProvider(provider)) {
      return NextResponse.json(
        { error: `Unsupported provider: ${provider}` },
        { status: 400 }
      );
    }

    deleteUserApiKey(db, request.user.userId, provider);

    log.info({ userId: request.user.userId, provider }, 'API key deleted');

    return NextResponse.json({ success: true });
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      'Failed to delete API key'
    );
    return NextResponse.json(
      { error: 'Failed to delete API key' },
      { status: 500 }
    );
  }
});
