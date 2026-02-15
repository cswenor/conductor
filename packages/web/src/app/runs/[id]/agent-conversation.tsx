'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui';
// Note: Radix ScrollArea doesn't work reliably inside table cells,
// so we use a plain div with overflow-y-auto instead.
import { Skeleton } from '@/components/ui/skeleton';
import { ChevronDown, ChevronRight } from 'lucide-react';

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

interface AgentConversationProps {
  agentInvocationId: string;
  runId: string;
  /** Live message count from parent (updated via SSE push). Triggers incremental fetch when it increases. */
  messageCount?: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function parseContentSafe(contentJson: string): unknown {
  try {
    return JSON.parse(contentJson);
  } catch {
    return null;
  }
}

/** Collapsible card used by all message types. Collapsed = fixed-height preview with fade. */
function CollapsibleContent({
  label,
  badge,
  extraBadges,
  children,
  defaultExpanded = false,
  muted = false,
}: {
  label: string;
  badge?: { variant: 'default' | 'secondary' | 'destructive' | 'success' | 'warning' | 'outline'; text: string };
  extraBadges?: React.ReactNode;
  children: React.ReactNode;
  defaultExpanded?: boolean;
  muted?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  return (
    <Card className={muted ? 'bg-muted/50' : ''}>
      <CardContent className="p-3">
        <button
          className="flex items-center gap-2 text-sm w-full text-left"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
          <Badge variant={badge?.variant ?? 'secondary'} className="text-xs">
            {badge?.text ?? label}
          </Badge>
          {extraBadges}
          {!expanded && (
            <span className="text-xs text-muted-foreground ml-auto">click to expand</span>
          )}
        </button>
        {expanded && (
          <div className="mt-2 max-h-[300px] overflow-y-auto">
            {children}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SystemMessage({ content }: { content: string | null }) {
  if (content === null) return <TruncatedMessage role="System Prompt" sizeBytes={0} />;

  const parsed = parseContentSafe(content);
  const text = typeof parsed === 'string' ? parsed : content;

  return (
    <CollapsibleContent label="System Prompt" muted>
      <pre className="text-xs whitespace-pre-wrap break-words">
        {text}
      </pre>
    </CollapsibleContent>
  );
}

function UserMessage({ content }: { content: string | null }) {
  if (content === null) return <TruncatedMessage role="Prompt" sizeBytes={0} />;

  const parsed = parseContentSafe(content);
  const text = typeof parsed === 'string' ? parsed : content;

  return (
    <CollapsibleContent label="Prompt" badge={{ variant: 'secondary', text: 'Prompt' }}>
      <pre className="text-sm whitespace-pre-wrap break-words">
        {text}
      </pre>
    </CollapsibleContent>
  );
}

function AssistantMessage({ msg, defaultExpanded = false }: { msg: AgentMessageResponse; defaultExpanded?: boolean }) {
  if (msg.contentJson === null) {
    return <TruncatedMessage role="Assistant" sizeBytes={msg.contentSizeBytes} />;
  }

  const parsed = parseContentSafe(msg.contentJson);
  const isError = msg.stopReason !== undefined && ['cancelled', 'timeout', 'auth_error', 'unknown'].includes(msg.stopReason);

  const extraBadges = (
    <>
      {msg.stopReason !== undefined && (
        <Badge variant="secondary" className="text-xs font-mono">
          {msg.stopReason}
        </Badge>
      )}
      {msg.tokensInput !== undefined && msg.tokensOutput !== undefined && (
        <span className="text-xs text-muted-foreground">
          {msg.tokensInput}in / {msg.tokensOutput}out
        </span>
      )}
    </>
  );

  // Parse as ContentBlock[] array
  if (Array.isArray(parsed)) {
    return (
      <CollapsibleContent
        label="Assistant"
        badge={{ variant: isError ? 'destructive' : 'default', text: 'Assistant' }}
        extraBadges={extraBadges}
        defaultExpanded={defaultExpanded}
      >
        <div className="space-y-2">
          {parsed.map((entry: unknown, idx: number) => {
            // Guard: skip non-object entries (nulls, primitives, etc.)
            if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
              return (
                <pre key={idx} className="text-xs whitespace-pre-wrap break-words text-muted-foreground">
                  {JSON.stringify(entry)}
                </pre>
              );
            }
            const block = entry as Record<string, unknown>;
            if (block['type'] === 'text') {
              return (
                <pre key={idx} className="text-sm whitespace-pre-wrap break-words">
                  {typeof block['text'] === 'string' ? block['text'] : ''}
                </pre>
              );
            }
            if (block['type'] === 'tool_use') {
              const inputStr = block['input'] !== undefined ? JSON.stringify(block['input'], null, 2) : '{}';
              return (
                <div key={idx} className="bg-muted/50 rounded p-2">
                  <div className="flex items-center gap-2 mb-1">
                    <Badge variant="secondary" className="text-xs font-mono">
                      {typeof block['name'] === 'string' ? block['name'] : 'tool'}
                    </Badge>
                  </div>
                  <code className="text-xs block whitespace-pre-wrap break-words">
                    {inputStr}
                  </code>
                </div>
              );
            }
            return (
              <pre key={idx} className="text-xs whitespace-pre-wrap break-words text-muted-foreground">
                {JSON.stringify(block, null, 2)}
              </pre>
            );
          })}
        </div>
      </CollapsibleContent>
    );
  }

  // Fallback: raw display with warning
  return (
    <CollapsibleContent
      label="Assistant"
      badge={{ variant: 'default', text: 'Assistant' }}
      extraBadges={<Badge variant="secondary" className="text-xs">Parse Error</Badge>}
      defaultExpanded={defaultExpanded}
    >
      <pre className="text-xs whitespace-pre-wrap break-words text-muted-foreground">
        {msg.contentJson}
      </pre>
    </CollapsibleContent>
  );
}

function ToolResultMessage({ msg }: { msg: AgentMessageResponse }) {
  if (msg.contentJson === null) {
    return <TruncatedMessage role="Tool Results" sizeBytes={msg.contentSizeBytes} />;
  }

  const parsed = parseContentSafe(msg.contentJson);

  if (Array.isArray(parsed)) {
    return (
      <CollapsibleContent label="Tool Results" muted>
        <div className="space-y-2">
          {parsed.map((entry: unknown, idx: number) => {
            // Guard: skip non-object entries
            if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
              return (
                <pre key={idx} className="text-xs whitespace-pre-wrap break-words text-muted-foreground">
                  {JSON.stringify(entry)}
                </pre>
              );
            }
            const result = entry as Record<string, unknown>;
            const isError = result['is_error'] === true;
            const rawContent = result['content'];
            const content = typeof rawContent === 'string'
              ? rawContent
              : (rawContent !== undefined ? JSON.stringify(rawContent, null, 2) : '');

            return (
              <div key={idx} className="rounded border p-2">
                <div className="flex items-center gap-2 mb-1">
                  <code className="text-xs text-muted-foreground">{typeof result['tool_use_id'] === 'string' ? result['tool_use_id'] : ''}</code>
                  <Badge variant={isError ? 'destructive' : 'success'} className="text-xs">
                    {isError ? 'error' : 'ok'}
                  </Badge>
                </div>
                <pre className="text-xs whitespace-pre-wrap break-words">{content}</pre>
              </div>
            );
          })}
        </div>
      </CollapsibleContent>
    );
  }

  // Fallback
  return (
    <CollapsibleContent
      label="Tool Results"
      muted
      extraBadges={<Badge variant="secondary" className="text-xs">Parse Error</Badge>}
    >
      <pre className="text-xs whitespace-pre-wrap break-words text-muted-foreground">
        {msg.contentJson}
      </pre>
    </CollapsibleContent>
  );
}

function TruncatedMessage({ role, sizeBytes }: { role: string; sizeBytes: number }) {
  return (
    <Card className="bg-muted/30">
      <CardContent className="p-3">
        <div className="flex items-center gap-2">
          <Badge variant="secondary" className="text-xs">{role}</Badge>
          <span className="text-xs text-muted-foreground">
            Content truncated{sizeBytes > 0 ? ` (${formatBytes(sizeBytes)})` : ''}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

function MessageCard({ msg, isLatestAssistant = false }: { msg: AgentMessageResponse; isLatestAssistant?: boolean }) {
  switch (msg.role) {
    case 'system':
      return <SystemMessage content={msg.contentJson} />;
    case 'user':
      return <UserMessage content={msg.contentJson} />;
    case 'assistant':
      return <AssistantMessage msg={msg} defaultExpanded={isLatestAssistant} />;
    case 'tool_result':
      return <ToolResultMessage msg={msg} />;
    default:
      return (
        <Card>
          <CardContent className="p-3">
            <Badge variant="secondary" className="text-xs">{msg.role}</Badge>
            <pre className="text-xs mt-1">{msg.contentJson ?? 'No content'}</pre>
          </CardContent>
        </Card>
      );
  }
}

export function AgentConversation({ agentInvocationId, runId, messageCount = 0 }: AgentConversationProps) {
  const [messages, setMessages] = useState<AgentMessageResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchingMore, setFetchingMore] = useState(false);
  const [total, setTotal] = useState(0);

  // Track highest turn index fetched so incremental fetches only get new messages
  const highWaterRef = useRef(-1);
  const fetchingRef = useRef(false);

  // Fetch all messages from a cursor, auto-paginating through all pages
  const fetchNewMessages = useCallback(async () => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;

    const isInitial = highWaterRef.current === -1;
    if (isInitial) {
      setLoading(true);
    } else {
      setFetchingMore(true);
    }

    try {
      let cursor = highWaterRef.current;
      let hasMore = true;

      while (hasMore) {
        const url = `/api/runs/${runId}/messages/${agentInvocationId}?limit=50&afterTurnIndex=${cursor}`;
        const res = await fetch(url);
        if (!res.ok) break;

        const data = (await res.json()) as MessagesPageResponse;
        if (data.messages.length === 0) break;

        const lastMsg = data.messages[data.messages.length - 1];
        if (lastMsg) {
          highWaterRef.current = lastMsg.turnIndex;
        }

        setMessages(prev => [...prev, ...data.messages]);
        setTotal(data.total);

        if (data.hasMore && data.nextCursor !== undefined) {
          cursor = data.nextCursor;
        } else {
          hasMore = false;
        }
      }
    } catch {
      // Silently fail
    } finally {
      setLoading(false);
      setFetchingMore(false);
      fetchingRef.current = false;
    }
  }, [agentInvocationId, runId]);

  // Initial load — fetch all available messages
  useEffect(() => {
    void fetchNewMessages();
  }, [fetchNewMessages]);

  // Incremental fetch when parent signals new messages via SSE push
  useEffect(() => {
    if (messageCount > total) {
      void fetchNewMessages();
    }
  }, [messageCount, total, fetchNewMessages]);

  if (loading) {
    return (
      <div className="space-y-2 p-4">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }

  if (messages.length === 0) {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        No conversation messages recorded for this invocation.
      </div>
    );
  }

  // Find the latest assistant message index to auto-expand only that one
  let latestAssistantId: string | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') {
      latestAssistantId = messages[i]?.agentMessageId;
      break;
    }
  }

  return (
    <div className="p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs text-muted-foreground">
          {total} {total === 1 ? 'message' : 'messages'}
        </span>
        {fetchingMore && (
          <span className="text-xs text-muted-foreground animate-pulse">Loading new messages...</span>
        )}
      </div>

      <div className="max-h-[500px] overflow-y-auto">
        <div className="space-y-2">
          {messages.map((msg) => (
            <MessageCard
              key={msg.agentMessageId}
              msg={msg}
              isLatestAssistant={msg.agentMessageId === latestAssistantId}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
