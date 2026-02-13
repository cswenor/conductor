/**
 * @vitest-environment jsdom
 *
 * Tests for the AgentConversation component.
 *
 * Verifies loading state, message rendering, empty state, truncation,
 * system prompt collapse, and "Load more" pagination.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';

// ---------------------------------------------------------------------------
// Mock lucide-react icons (avoids SVG rendering issues in jsdom)
// ---------------------------------------------------------------------------

vi.mock('lucide-react', () => ({
  ChevronDown: ({ className }: { className?: string }) =>
    React.createElement('span', { 'data-testid': 'chevron-down', className }, 'v'),
  ChevronRight: ({ className }: { className?: string }) =>
    React.createElement('span', { 'data-testid': 'chevron-right', className }, '>'),
}));

// ---------------------------------------------------------------------------
// Mock shadcn/ui components to avoid Radix DOM complexity in jsdom
// ---------------------------------------------------------------------------

vi.mock('@/components/ui/card', () => ({
  Card: ({ children, className }: { children: React.ReactNode; className?: string }) =>
    React.createElement('div', { 'data-testid': 'card', className }, children),
  CardContent: ({ children, className }: { children: React.ReactNode; className?: string }) =>
    React.createElement('div', { 'data-testid': 'card-content', className }, children),
}));

vi.mock('@/components/ui', () => ({
  Badge: ({ children, variant, className }: { children: React.ReactNode; variant?: string; className?: string }) =>
    React.createElement('span', { 'data-testid': 'badge', 'data-variant': variant, className }, children),
  Button: ({ children, onClick, disabled, variant, size }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    variant?: string;
    size?: string;
  }) =>
    React.createElement('button', {
      'data-testid': 'button',
      onClick,
      disabled,
      'data-variant': variant,
      'data-size': size,
    }, children),
}));

vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) =>
    React.createElement('div', { 'data-testid': 'scroll-area', className }, children),
}));

vi.mock('@/components/ui/skeleton', () => ({
  Skeleton: ({ className }: { className?: string }) =>
    React.createElement('div', { 'data-testid': 'skeleton', className }),
}));

vi.mock('@/components/ui/alert', () => ({
  Alert: ({ children, className }: { children: React.ReactNode; className?: string }) =>
    React.createElement('div', { 'data-testid': 'alert', className }, children),
  AlertDescription: ({ children, className }: { children: React.ReactNode; className?: string }) =>
    React.createElement('div', { 'data-testid': 'alert-description', className }, children),
}));

// ---------------------------------------------------------------------------
// Import component after mocks
// ---------------------------------------------------------------------------

import { AgentConversation } from './agent-conversation';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockMessage {
  agentMessageId: string;
  agentInvocationId?: string;
  turnIndex: number;
  role: string;
  contentJson: string | null;
  contentSizeBytes: number;
  truncated?: boolean;
  tokensInput?: number;
  tokensOutput?: number;
  stopReason?: string;
  createdAt?: string;
}

function mockMessagesResponse(
  messages: MockMessage[],
  hasMore = false,
  total?: number,
) {
  return {
    ok: true,
    json: vi.fn().mockResolvedValue({
      messages: messages.map((m) => ({
        agentInvocationId: 'ai_1',
        createdAt: '2025-01-01T00:00:00.000Z',
        ...m,
      })),
      total: total ?? messages.length,
      hasMore,
      nextCursor: hasMore ? messages.at(-1)?.turnIndex : undefined,
    }),
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  global.fetch = mockFetch as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentConversation', () => {
  it('renders loading skeletons while fetching', () => {
    // Never resolve the fetch so loading state persists
    mockFetch.mockReturnValue(new Promise(() => {}));

    render(
      <AgentConversation agentInvocationId="ai_1" runId="run_1" />,
    );

    const skeletons = screen.getAllByTestId('skeleton');
    expect(skeletons.length).toBeGreaterThanOrEqual(1);
  });

  it('renders messages after fetch resolves', async () => {
    mockFetch.mockResolvedValue(
      mockMessagesResponse([
        {
          agentMessageId: 'am_1',
          turnIndex: 0,
          role: 'user',
          contentJson: '"Hello, agent!"',
          contentSizeBytes: 15,
        },
        {
          agentMessageId: 'am_2',
          turnIndex: 1,
          role: 'assistant',
          contentJson: '[{"type":"text","text":"Hi there!"}]',
          contentSizeBytes: 35,
        },
      ]),
    );

    render(
      <AgentConversation agentInvocationId="ai_1" runId="run_1" />,
    );

    await waitFor(() => {
      expect(screen.getByText('Hello, agent!')).toBeDefined();
    });

    expect(screen.getByText('Hi there!')).toBeDefined();
  });

  it('shows empty state when no messages are returned', async () => {
    mockFetch.mockResolvedValue(mockMessagesResponse([]));

    render(
      <AgentConversation agentInvocationId="ai_1" runId="run_1" />,
    );

    await waitFor(() => {
      expect(
        screen.getByText('No conversation messages recorded for this invocation.'),
      ).toBeDefined();
    });
  });

  it('handles malformed contentJson by displaying raw content', async () => {
    // Assistant message with non-array contentJson triggers the Parse Error fallback
    mockFetch.mockResolvedValue(
      mockMessagesResponse([
        {
          agentMessageId: 'am_1',
          turnIndex: 0,
          role: 'assistant',
          contentJson: '{"not":"an array"}',
          contentSizeBytes: 18,
        },
      ]),
    );

    render(
      <AgentConversation agentInvocationId="ai_1" runId="run_1" />,
    );

    await waitFor(() => {
      expect(screen.getByText('Parse Error')).toBeDefined();
    });

    // The raw contentJson should be displayed somewhere
    expect(screen.getByText('{"not":"an array"}')).toBeDefined();
  });

  it('shows truncation indicator for truncated messages', async () => {
    mockFetch.mockResolvedValue(
      mockMessagesResponse([
        {
          agentMessageId: 'am_1',
          turnIndex: 0,
          role: 'assistant',
          contentJson: null,
          truncated: true,
          contentSizeBytes: 200_000,
        },
      ]),
    );

    render(
      <AgentConversation agentInvocationId="ai_1" runId="run_1" />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Content truncated/)).toBeDefined();
    });
  });

  it('system prompt is collapsed by default', async () => {
    mockFetch.mockResolvedValue(
      mockMessagesResponse([
        {
          agentMessageId: 'am_1',
          turnIndex: 0,
          role: 'system',
          contentJson: '"You are a helpful coding assistant."',
          contentSizeBytes: 38,
        },
      ]),
    );

    render(
      <AgentConversation agentInvocationId="ai_1" runId="run_1" />,
    );

    await waitFor(() => {
      expect(screen.getByText('System Prompt')).toBeDefined();
    });

    // The actual prompt text should NOT be visible when collapsed
    expect(screen.queryByText('You are a helpful coding assistant.')).toBeNull();
  });

  it('expands system prompt on click', async () => {
    mockFetch.mockResolvedValue(
      mockMessagesResponse([
        {
          agentMessageId: 'am_1',
          turnIndex: 0,
          role: 'system',
          contentJson: '"You are a helpful coding assistant."',
          contentSizeBytes: 38,
        },
      ]),
    );

    render(
      <AgentConversation agentInvocationId="ai_1" runId="run_1" />,
    );

    await waitFor(() => {
      expect(screen.getByText('System Prompt')).toBeDefined();
    });

    // Click on the System Prompt button to expand
    fireEvent.click(screen.getByText('System Prompt'));

    await waitFor(() => {
      expect(screen.getByText('You are a helpful coding assistant.')).toBeDefined();
    });
  });

  it('shows "Load more" button when hasMore is true', async () => {
    mockFetch.mockResolvedValue(
      mockMessagesResponse(
        [
          {
            agentMessageId: 'am_1',
            turnIndex: 0,
            role: 'user',
            contentJson: '"First page"',
            contentSizeBytes: 12,
          },
        ],
        true, // hasMore
        5,    // total
      ),
    );

    render(
      <AgentConversation agentInvocationId="ai_1" runId="run_1" />,
    );

    await waitFor(() => {
      expect(screen.getByText('Load more')).toBeDefined();
    });
  });

  it('shows banner with message count when hasMore and messages < total', async () => {
    mockFetch.mockResolvedValue(
      mockMessagesResponse(
        [
          {
            agentMessageId: 'am_1',
            turnIndex: 0,
            role: 'user',
            contentJson: '"Hello"',
            contentSizeBytes: 7,
          },
          {
            agentMessageId: 'am_2',
            turnIndex: 1,
            role: 'assistant',
            contentJson: '[{"type":"text","text":"Hi"}]',
            contentSizeBytes: 28,
          },
        ],
        true, // hasMore
        10,   // total
      ),
    );

    render(
      <AgentConversation agentInvocationId="ai_1" runId="run_1" />,
    );

    await waitFor(() => {
      expect(screen.getByText('Showing 2 of 10 messages.')).toBeDefined();
    });
  });

  it('does not show "Load more" button when hasMore is false', async () => {
    mockFetch.mockResolvedValue(
      mockMessagesResponse(
        [
          {
            agentMessageId: 'am_1',
            turnIndex: 0,
            role: 'user',
            contentJson: '"Only message"',
            contentSizeBytes: 14,
          },
        ],
        false, // hasMore
      ),
    );

    render(
      <AgentConversation agentInvocationId="ai_1" runId="run_1" />,
    );

    await waitFor(() => {
      expect(screen.getByText('Only message')).toBeDefined();
    });

    expect(screen.queryByText('Load more')).toBeNull();
  });

  it('fetches next page when "Load more" is clicked', async () => {
    // First fetch: page 1
    mockFetch.mockResolvedValueOnce(
      mockMessagesResponse(
        [
          {
            agentMessageId: 'am_1',
            turnIndex: 0,
            role: 'user',
            contentJson: '"Page one"',
            contentSizeBytes: 10,
          },
        ],
        true, // hasMore
        3,    // total
      ),
    );

    render(
      <AgentConversation agentInvocationId="ai_1" runId="run_1" />,
    );

    await waitFor(() => {
      expect(screen.getByText('Load more')).toBeDefined();
    });

    // Second fetch: page 2
    mockFetch.mockResolvedValueOnce(
      mockMessagesResponse(
        [
          {
            agentMessageId: 'am_2',
            turnIndex: 1,
            role: 'assistant',
            contentJson: '[{"type":"text","text":"Page two"}]',
            contentSizeBytes: 34,
          },
        ],
        false,
        3,
      ),
    );

    fireEvent.click(screen.getByText('Load more'));

    await waitFor(() => {
      expect(screen.getByText('Page two')).toBeDefined();
    });

    // Verify second fetch was called with cursor
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const secondCall = mockFetch.mock.calls[1] as string[] | undefined;
    expect(secondCall).toBeDefined();
    const secondCallUrl = secondCall?.[0] ?? '';
    expect(secondCallUrl).toContain('afterTurnIndex=0');
  });

  it('renders tool_use block with missing input without crashing', async () => {
    mockFetch.mockResolvedValue(
      mockMessagesResponse([
        {
          agentMessageId: 'am_1',
          turnIndex: 0,
          role: 'assistant',
          contentJson: JSON.stringify([
            { type: 'tool_use', name: 'read_file', id: 'tu_1' },
          ]),
          contentSizeBytes: 50,
        },
      ]),
    );

    render(
      <AgentConversation agentInvocationId="ai_1" runId="run_1" />,
    );

    await waitFor(() => {
      expect(screen.getByText('read_file')).toBeDefined();
    });

    // Should render '{}' as fallback for missing input
    expect(screen.getByText('{}')).toBeDefined();
  });

  it('renders tool_use block with non-object input without crashing', async () => {
    mockFetch.mockResolvedValue(
      mockMessagesResponse([
        {
          agentMessageId: 'am_1',
          turnIndex: 0,
          role: 'assistant',
          contentJson: JSON.stringify([
            { type: 'tool_use', name: 'run_cmd', id: 'tu_2', input: null },
          ]),
          contentSizeBytes: 55,
        },
      ]),
    );

    render(
      <AgentConversation agentInvocationId="ai_1" runId="run_1" />,
    );

    await waitFor(() => {
      expect(screen.getByText('run_cmd')).toBeDefined();
    });

    // null input should be stringified
    expect(screen.getByText('null')).toBeDefined();
  });

  it('renders assistant content array with non-object entries without crashing', async () => {
    mockFetch.mockResolvedValue(
      mockMessagesResponse([
        {
          agentMessageId: 'am_1',
          turnIndex: 0,
          role: 'assistant',
          contentJson: JSON.stringify([
            'just a string',
            42,
            null,
            { type: 'text', text: 'valid block' },
          ]),
          contentSizeBytes: 80,
        },
      ]),
    );

    render(
      <AgentConversation agentInvocationId="ai_1" runId="run_1" />,
    );

    await waitFor(() => {
      expect(screen.getByText('valid block')).toBeDefined();
    });

    // Non-object entries should be rendered as JSON strings
    expect(screen.getByText('"just a string"')).toBeDefined();
  });

  it('calls fetch with correct URL on mount', async () => {
    mockFetch.mockResolvedValue(mockMessagesResponse([]));

    render(
      <AgentConversation agentInvocationId="ai_test" runId="run_test" />,
    );

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    const firstCall = mockFetch.mock.calls[0] as string[] | undefined;
    expect(firstCall).toBeDefined();
    const url = firstCall?.[0] ?? '';
    expect(url).toBe('/api/runs/run_test/messages/ai_test?limit=50&afterTurnIndex=-1');
  });
});
