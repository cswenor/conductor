'use client';

import { useState, useEffect, useCallback } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui';
import { Button } from '@/components/ui';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
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

function SystemMessage({ content }: { content: string | null }) {
  const [expanded, setExpanded] = useState(false);

  if (content === null) return <TruncatedMessage role="system" sizeBytes={0} />;

  const parsed = parseContentSafe(content);
  const text = typeof parsed === 'string' ? parsed : content;

  return (
    <Card className="bg-muted/50">
      <CardContent className="p-3">
        <button
          className="flex items-center gap-2 text-sm font-medium text-muted-foreground w-full text-left"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          System Prompt
        </button>
        {expanded && (
          <pre className="mt-2 text-xs whitespace-pre-wrap break-words max-h-[300px] overflow-y-auto">
            {text}
          </pre>
        )}
      </CardContent>
    </Card>
  );
}

function UserMessage({ content }: { content: string | null }) {
  const [expanded, setExpanded] = useState(false);

  if (content === null) return <TruncatedMessage role="user" sizeBytes={0} />;

  const parsed = parseContentSafe(content);
  const text = typeof parsed === 'string' ? parsed : content;
  const isLong = text.length > 500;

  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-center gap-2 mb-1">
          <Badge variant="secondary" className="text-xs">User</Badge>
        </div>
        <pre className="text-sm whitespace-pre-wrap break-words">
          {isLong && !expanded ? `${text.substring(0, 500)}...` : text}
        </pre>
        {isLong && (
          <button
            className="text-xs text-primary mt-1"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? 'Show less' : 'Show more'}
          </button>
        )}
      </CardContent>
    </Card>
  );
}

function AssistantMessage({ msg }: { msg: AgentMessageResponse }) {
  if (msg.contentJson === null) {
    return <TruncatedMessage role="assistant" sizeBytes={msg.contentSizeBytes} />;
  }

  const parsed = parseContentSafe(msg.contentJson);
  const isError = msg.stopReason !== undefined && ['cancelled', 'timeout', 'auth_error', 'unknown'].includes(msg.stopReason);

  // Parse as ContentBlock[] array
  if (Array.isArray(parsed)) {
    return (
      <Card className={isError ? 'border-destructive/50' : ''}>
        <CardContent className="p-3">
          <div className="flex items-center gap-2 mb-1">
            <Badge variant={isError ? 'destructive' : 'default'} className="text-xs">
              Assistant
            </Badge>
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
          </div>
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
                const truncatedInput = inputStr.length > 200 ? `${inputStr.substring(0, 200)}...` : inputStr;
                return (
                  <div key={idx} className="bg-muted/50 rounded p-2">
                    <div className="flex items-center gap-2 mb-1">
                      <Badge variant="secondary" className="text-xs font-mono">
                        {typeof block['name'] === 'string' ? block['name'] : 'tool'}
                      </Badge>
                    </div>
                    <code className="text-xs block whitespace-pre-wrap break-words">
                      {truncatedInput}
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
        </CardContent>
      </Card>
    );
  }

  // Fallback: raw display with warning
  return (
    <Card>
      <CardContent className="p-3">
        <div className="flex items-center gap-2 mb-1">
          <Badge variant="default" className="text-xs">Assistant</Badge>
          <Badge variant="warning" className="text-xs">Parse Error</Badge>
        </div>
        <pre className="text-xs whitespace-pre-wrap break-words text-muted-foreground">
          {msg.contentJson}
        </pre>
      </CardContent>
    </Card>
  );
}

function ToolResultMessage({ msg }: { msg: AgentMessageResponse }) {
  if (msg.contentJson === null) {
    return <TruncatedMessage role="tool_result" sizeBytes={msg.contentSizeBytes} />;
  }

  const parsed = parseContentSafe(msg.contentJson);

  if (Array.isArray(parsed)) {
    return (
      <Card className="bg-muted/50">
        <CardContent className="p-3">
          <div className="flex items-center gap-2 mb-1">
            <Badge variant="secondary" className="text-xs">Tool Results</Badge>
          </div>
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
              const truncated = content.length > 300 ? `${content.substring(0, 300)}...` : content;

              return (
                <div key={idx} className="rounded border p-2">
                  <div className="flex items-center gap-2 mb-1">
                    <code className="text-xs text-muted-foreground">{typeof result['tool_use_id'] === 'string' ? result['tool_use_id'] : ''}</code>
                    <Badge variant={isError ? 'destructive' : 'success'} className="text-xs">
                      {isError ? 'error' : 'ok'}
                    </Badge>
                  </div>
                  <pre className="text-xs whitespace-pre-wrap break-words">{truncated}</pre>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    );
  }

  // Fallback
  return (
    <Card className="bg-muted/50">
      <CardContent className="p-3">
        <div className="flex items-center gap-2 mb-1">
          <Badge variant="secondary" className="text-xs">Tool Results</Badge>
          <Badge variant="warning" className="text-xs">Parse Error</Badge>
        </div>
        <pre className="text-xs whitespace-pre-wrap break-words text-muted-foreground">
          {msg.contentJson}
        </pre>
      </CardContent>
    </Card>
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

function MessageCard({ msg }: { msg: AgentMessageResponse }) {
  switch (msg.role) {
    case 'system':
      return <SystemMessage content={msg.contentJson} />;
    case 'user':
      return <UserMessage content={msg.contentJson} />;
    case 'assistant':
      return <AssistantMessage msg={msg} />;
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

export function AgentConversation({ agentInvocationId, runId }: AgentConversationProps) {
  const [messages, setMessages] = useState<AgentMessageResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<number | undefined>();
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);

  const fetchMessages = useCallback(async (afterTurnIndex: number = -1, append: boolean = false) => {
    if (append) {
      setLoadingMore(true);
    } else {
      setLoading(true);
    }

    try {
      const url = `/api/runs/${runId}/messages/${agentInvocationId}?limit=50&afterTurnIndex=${afterTurnIndex}`;
      const res = await fetch(url);
      if (!res.ok) return;

      const data = (await res.json()) as MessagesPageResponse;

      if (append) {
        setMessages(prev => [...prev, ...data.messages]);
      } else {
        setMessages(data.messages);
      }
      setTotal(data.total);
      setHasMore(data.hasMore);
      setNextCursor(data.nextCursor);
    } catch {
      // Silently fail
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [agentInvocationId, runId]);

  useEffect(() => {
    void fetchMessages();
  }, [fetchMessages]);

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

  return (
    <div className="p-4">
      {hasMore && messages.length < total && (
        <Alert className="mb-3">
          <AlertDescription className="text-sm">
            Showing {messages.length} of {total} messages.
          </AlertDescription>
        </Alert>
      )}

      <ScrollArea className="max-h-[600px]">
        <div className="space-y-2">
          {messages.map((msg) => (
            <MessageCard key={msg.agentMessageId} msg={msg} />
          ))}
        </div>
      </ScrollArea>

      {hasMore && (
        <div className="mt-3 text-center">
          <Button
            variant="outline"
            size="sm"
            disabled={loadingMore}
            onClick={() => {
              if (nextCursor !== undefined) {
                void fetchMessages(nextCursor, true);
              }
            }}
          >
            {loadingMore ? 'Loading...' : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  );
}
