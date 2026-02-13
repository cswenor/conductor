/**
 * Agent Messages API
 *
 * GET /api/runs/:id/messages/:invocationId
 * Returns paginated conversation messages for an agent invocation.
 */

import { NextResponse } from 'next/server';
import {
  createLogger,
  getRun,
  getProject,
  canAccessProject,
  getAgentInvocation,
  listAgentMessagesPaginated,
  countAgentMessages,
} from '@conductor/shared';
import { ensureBootstrap, getDb } from '@/lib/bootstrap';
import { withAuth, type AuthenticatedRequest } from '@/lib/auth';

const log = createLogger({ name: 'conductor:api:agent-messages' });

interface AgentMessageResponse {
  agentMessageId: string;
  agentInvocationId: string;
  turnIndex: number;
  role: string;
  contentJson: string | null;
  truncated?: boolean;
  contentSizeBytes: number;
  tokensInput?: number;
  tokensOutput?: number;
  stopReason?: string;
  createdAt: string;
}

interface MessagesPageResponse {
  messages: AgentMessageResponse[];
  total: number;
  hasMore: boolean;
  truncatedByBudget?: boolean;
  nextCursor?: number;
}

const MAX_RESPONSE_BUDGET = 2_097_152; // 2MB
const LARGE_MESSAGE_THRESHOLD = 100_000; // 100KB

interface RouteParams {
  params: Promise<{ id: string; invocationId: string }>;
}

export const GET = withAuth(async (
  request: AuthenticatedRequest,
  { params }: RouteParams,
): Promise<NextResponse> => {
  try {
    await ensureBootstrap();
    const db = await getDb();
    const { id: runId, invocationId } = await params;

    // Verify run exists
    const run = getRun(db, runId);
    if (run === null) {
      return NextResponse.json(
        { error: 'Run not found' },
        { status: 404 },
      );
    }

    // Verify project access
    const project = getProject(db, run.projectId);
    if (project === null || !canAccessProject(request.user, project)) {
      return NextResponse.json(
        { error: 'Run not found' },
        { status: 404 },
      );
    }

    // Verify invocation belongs to this run
    const invocation = getAgentInvocation(db, invocationId);
    if (invocation?.runId !== runId) {
      return NextResponse.json(
        { error: 'Invocation not found' },
        { status: 404 },
      );
    }

    // Parse query params with NaN handling
    const url = new URL(request.url);
    const rawLimit = parseInt(url.searchParams.get('limit') ?? '50', 10);
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 50, 1), 200);
    const rawAfterTurnIndex = parseInt(url.searchParams.get('afterTurnIndex') ?? '-1', 10);
    const afterTurnIndex = Number.isFinite(rawAfterTurnIndex) ? rawAfterTurnIndex : -1;

    // DB-backed pagination: fetch only the page we need + 1 to detect hasMore
    const total = countAgentMessages(db, invocationId);
    const fetchLimit = limit + 1; // fetch one extra to know if more exist
    const fetched = listAgentMessagesPaginated(db, invocationId, afterTurnIndex, fetchLimit);

    // Check if there are more rows beyond the page
    const hasExtraRow = fetched.length > limit;
    const pageRows = hasExtraRow ? fetched.slice(0, limit) : fetched;

    // Apply budget + large-message truncation
    const pageMessages: AgentMessageResponse[] = [];
    let cumulativeSize = 0;
    let truncatedByBudget = false;

    for (const msg of pageRows) {
      // Budget check (first-row guarantee: always include at least 1)
      if (
        pageMessages.length > 0 &&
        cumulativeSize + msg.contentSizeBytes > MAX_RESPONSE_BUDGET
      ) {
        truncatedByBudget = true;
        break;
      }

      cumulativeSize += msg.contentSizeBytes;

      // Schema-aware preview for large messages
      if (msg.contentSizeBytes > LARGE_MESSAGE_THRESHOLD) {
        pageMessages.push({
          agentMessageId: msg.agentMessageId,
          agentInvocationId: msg.agentInvocationId,
          turnIndex: msg.turnIndex,
          role: msg.role,
          contentJson: null,
          truncated: true,
          contentSizeBytes: msg.contentSizeBytes,
          tokensInput: msg.tokensInput,
          tokensOutput: msg.tokensOutput,
          stopReason: msg.stopReason,
          createdAt: msg.createdAt,
        });
      } else {
        pageMessages.push({
          agentMessageId: msg.agentMessageId,
          agentInvocationId: msg.agentInvocationId,
          turnIndex: msg.turnIndex,
          role: msg.role,
          contentJson: msg.contentJson,
          contentSizeBytes: msg.contentSizeBytes,
          tokensInput: msg.tokensInput,
          tokensOutput: msg.tokensOutput,
          stopReason: msg.stopReason,
          createdAt: msg.createdAt,
        });
      }
    }

    // Determine hasMore: extra row exists OR budget was hit before all page rows processed
    const lastMsg = pageMessages[pageMessages.length - 1];
    const hasMore = hasExtraRow || truncatedByBudget;

    const response: MessagesPageResponse = {
      messages: pageMessages,
      total,
      hasMore,
    };

    if (truncatedByBudget) {
      response.truncatedByBudget = true;
    }

    if (hasMore && lastMsg !== undefined) {
      response.nextCursor = lastMsg.turnIndex;
    }

    return NextResponse.json(response);
  } catch (err) {
    log.error(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      'Failed to get agent messages',
    );
    return NextResponse.json(
      { error: 'Failed to get agent messages' },
      { status: 500 },
    );
  }
});
