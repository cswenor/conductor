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
  listAgentMessages,
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

    // Parse query params
    const url = new URL(request.url);
    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1),
      200,
    );
    const afterTurnIndex = parseInt(
      url.searchParams.get('afterTurnIndex') ?? '-1',
      10,
    );

    // Fetch all messages for this invocation (already ordered by turn_index)
    const allMessages = listAgentMessages(db, invocationId);
    const total = allMessages.length;

    // Apply cursor: filter messages with turn_index > afterTurnIndex
    const filtered = allMessages.filter((m) => m.turnIndex > afterTurnIndex);

    // Apply limit + budget
    const pageMessages: AgentMessageResponse[] = [];
    let cumulativeSize = 0;
    let truncatedByBudget = false;

    for (let i = 0; i < Math.min(filtered.length, limit); i++) {
      const msg = filtered[i];
      if (msg === undefined) continue;

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

    // Determine hasMore
    const lastMsg = pageMessages[pageMessages.length - 1];
    const lastIncludedTurnIndex =
      lastMsg !== undefined
        ? lastMsg.turnIndex
        : afterTurnIndex;
    const remainingAfterPage = allMessages.filter(
      (m) => m.turnIndex > lastIncludedTurnIndex,
    ).length;
    const hasMore = remainingAfterPage > 0 || truncatedByBudget;

    const response: MessagesPageResponse = {
      messages: pageMessages,
      total,
      hasMore,
    };

    if (truncatedByBudget) {
      response.truncatedByBudget = true;
    }

    if (hasMore && pageMessages.length > 0) {
      response.nextCursor = lastIncludedTurnIndex;
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
