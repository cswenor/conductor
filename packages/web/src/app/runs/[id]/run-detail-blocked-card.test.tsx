/**
 * @vitest-environment jsdom
 *
 * Focused tests for the blocked-card rendering paths inside RunDetailContent.
 * Covers rate-limit-specific UI, gate_failed, and generic blocked states.
 *
 * Follows the same mock-heavy pattern as agent-conversation.test.tsx
 * to isolate from Radix/Next.js runtime dependencies.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';
import type { RunDetailData } from '@/lib/data/run-detail';

// ---------------------------------------------------------------------------
// Mock next/navigation (useRouter, Link)
// ---------------------------------------------------------------------------

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => '/runs/run_1',
}));

vi.mock('next/link', () => ({
  default: ({ children, ...props }: { children: React.ReactNode; href: string }) =>
    React.createElement('a', props, children),
}));

// ---------------------------------------------------------------------------
// Mock lucide-react icons
// ---------------------------------------------------------------------------

vi.mock('lucide-react', () => {
  const stub = (name: string) =>
    function Icon({ className }: { className?: string }) {
      return React.createElement('span', { 'data-testid': `icon-${name}`, className });
    };
  return {
    ArrowLeft: stub('arrow-left'),
    XCircle: stub('x-circle'),
    GitBranch: stub('git-branch'),
    Clock: stub('clock'),
    Hash: stub('hash'),
    CheckCircle: stub('check-circle'),
    AlertTriangle: stub('alert-triangle'),
    Circle: stub('circle'),
    RefreshCw: stub('refresh-cw'),
    ThumbsUp: stub('thumbs-up'),
    ThumbsDown: stub('thumbs-down'),
    Pencil: stub('pencil'),
    ShieldAlert: stub('shield-alert'),
    ChevronDown: stub('chevron-down'),
    ChevronRight: stub('chevron-right'),
  };
});

// ---------------------------------------------------------------------------
// Mock shadcn/ui components (avoid Radix DOM complexity)
// ---------------------------------------------------------------------------

vi.mock('@/components/ui', () => ({
  Badge: ({ children, variant, className }: { children: React.ReactNode; variant?: string; className?: string }) =>
    React.createElement('span', { 'data-testid': 'badge', 'data-variant': variant, className }, children),
  Button: ({ children, onClick, disabled, variant, className }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean; variant?: string; className?: string }) =>
    React.createElement('button', { onClick, disabled, 'data-variant': variant, className }, children),
}));

vi.mock('@/components/ui/card', () => ({
  Card: ({ children, className }: { children: React.ReactNode; className?: string }) =>
    React.createElement('div', { 'data-testid': 'card', className }, children),
  CardContent: ({ children, className }: { children: React.ReactNode; className?: string }) =>
    React.createElement('div', { 'data-testid': 'card-content', className }, children),
  CardHeader: ({ children, className }: { children: React.ReactNode; className?: string }) =>
    React.createElement('div', { 'data-testid': 'card-header', className }, children),
  CardTitle: ({ children, className }: { children: React.ReactNode; className?: string }) =>
    React.createElement('div', { 'data-testid': 'card-title', className }, children),
}));

vi.mock('@/components/ui/separator', () => ({
  Separator: ({ className }: { className?: string }) =>
    React.createElement('hr', { 'data-testid': 'separator', className }),
}));

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
  DialogContent: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
  DialogDescription: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
  DialogFooter: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
  DialogHeader: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
  DialogTitle: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
}));

vi.mock('@/components/ui/textarea', () => ({
  Textarea: (props: Record<string, unknown>) => React.createElement('textarea', props),
}));

vi.mock('@/components/ui/label', () => ({
  Label: ({ children }: { children: React.ReactNode }) => React.createElement('label', null, children),
}));

vi.mock('@/components/ui/table', () => ({
  Table: ({ children }: { children: React.ReactNode }) => React.createElement('table', null, children),
  TableBody: ({ children }: { children: React.ReactNode }) => React.createElement('tbody', null, children),
  TableCell: ({ children }: { children: React.ReactNode }) => React.createElement('td', null, children),
  TableHead: ({ children }: { children: React.ReactNode }) => React.createElement('th', null, children),
  TableHeader: ({ children }: { children: React.ReactNode }) => React.createElement('thead', null, children),
  TableRow: ({ children }: { children: React.ReactNode }) => React.createElement('tr', null, children),
}));

vi.mock('@/components/ui/alert', () => ({
  Alert: ({ children, className }: { children: React.ReactNode; className?: string }) =>
    React.createElement('div', { 'data-testid': 'alert', className }, children),
  AlertTitle: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'alert-title' }, children),
  AlertDescription: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'alert-description' }, children),
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
  TooltipProvider: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
}));

// ---------------------------------------------------------------------------
// Mock lib modules
// ---------------------------------------------------------------------------

vi.mock('@/lib/action-toast', () => ({
  toastActionResult: vi.fn(),
}));

vi.mock('@/lib/actions/run-actions', () => ({
  approvePlan: vi.fn(),
  revisePlan: vi.fn(),
  rejectRun: vi.fn(),
  retryRun: vi.fn(),
  cancelRun: vi.fn(),
  grantPolicyException: vi.fn(),
  denyPolicyException: vi.fn(),
}));

vi.mock('@/hooks/use-live-refresh', () => ({
  useLiveRefresh: vi.fn(),
}));

vi.mock('./agent-conversation', () => ({
  AgentConversation: () => React.createElement('div', { 'data-testid': 'agent-conversation' }),
}));

vi.mock('./active-agent-banner', () => ({
  ActiveAgentBanner: () => null,
  ElapsedTimer: () => null,
}));

// ---------------------------------------------------------------------------
// Import component after mocks
// ---------------------------------------------------------------------------

import { RunDetailContent } from './run-detail-content';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRunData(overrides: Partial<RunDetailData['run']> = {}, dataOverrides: Partial<RunDetailData> = {}): RunDetailData {
  const now = new Date().toISOString();
  return {
    run: {
      runId: 'run_1',
      taskId: 'task_1',
      projectId: 'proj_1',
      repoId: 'repo_1',
      runNumber: 1,
      phase: 'executing',
      step: 'implementer_apply_changes',
      policySetId: 'ps_1',
      lastEventSequence: 10,
      nextSequence: 11,
      baseBranch: 'main',
      branch: 'conductor/run_1',
      headSha: 'abc123',
      startedAt: now,
      updatedAt: now,
      completedAt: undefined,
      result: undefined,
      resultReason: undefined,
      blockedReason: undefined,
      blockedContextJson: undefined,
      approvalCycle: 0,
      planRevisions: 0,
      reviewRounds: 0,
      testFixAttempts: 0,
      implementerBackend: 'raw',
      ...overrides,
    } as RunDetailData['run'],
    task: {
      taskId: 'task_1',
      githubTitle: 'Test Task',
      githubIssueNumber: 42,
      githubType: 'issue',
      githubState: 'open',
    },
    repo: {
      repoId: 'repo_1',
      githubFullName: 'owner/repo',
      githubOwner: 'owner',
      githubName: 'repo',
    },
    events: [],
    gates: {},
    gateEvaluations: [],
    operatorActions: [],
    agentInvocations: [],
    messageCounts: {},
    requiredGates: [],
    optionalGates: [],
    ...dataOverrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup();
});

describe('RunDetailContent blocked card', () => {
  it('shows rate-limit agent info and retry guidance when rate_limit_exhausted', () => {
    const data = makeRunData({
      phase: 'blocked',
      blockedReason: 'rate_limit_exhausted',
      blockedContextJson: JSON.stringify({
        error: 'rate_limit_exhausted',
        prior_phase: 'executing',
        prior_step: 'implementer_apply_changes',
        reason_code: 'rate_limit_exhausted',
        agent: 'implementer',
        retries_exhausted: 5,
        max_retries: 5,
        error_detail: "Rate-limit retry budget exhausted for agent 'implementer' (maxRetries=5).",
      }),
    });

    render(<RunDetailContent data={data} />);

    // Rate-limit-specific UI visible
    expect(screen.getByText('implementer')).toBeDefined();
    expect(screen.getByText(/after 5\/5 retries/)).toBeDefined();
    expect(screen.getByText('Click Retry to attempt again with a fresh retry budget.')).toBeDefined();

    // Generic guidance NOT shown
    expect(screen.queryByText('Use the actions bar below to retry or cancel this run.')).toBeNull();
  });

  it('shows retry guidance without agent details for historical rate-limit rows', () => {
    // Historical row: blockedReason is rate_limit_exhausted but context lacks agent/retry fields
    const data = makeRunData({
      phase: 'blocked',
      blockedReason: 'rate_limit_exhausted',
      blockedContextJson: JSON.stringify({
        error: 'rate_limit_exhausted',
        prior_phase: 'executing',
        prior_step: 'implementer_apply_changes',
        reason_code: 'rate_limit_exhausted',
      }),
    });

    render(<RunDetailContent data={data} />);

    // Retry guidance shown
    expect(screen.getByText('Click Retry to attempt again with a fresh retry budget.')).toBeDefined();

    // Agent details NOT shown (no agent field in context)
    expect(screen.queryByText(/was rate-limited/)).toBeNull();

    // Generic guidance NOT shown
    expect(screen.queryByText('Use the actions bar below to retry or cancel this run.')).toBeNull();
  });

  it('shows generic guidance for non-rate-limit blocked runs', () => {
    const data = makeRunData({
      phase: 'blocked',
      blockedReason: 'gate_failed',
      blockedContextJson: JSON.stringify({
        error: 'Tests failed',
        prior_phase: 'executing',
        prior_step: 'implementer_apply_changes',
        reason_code: 'gate_failed',
        gate_id: 'tests_pass',
      }),
    });

    render(<RunDetailContent data={data} />);

    // Generic guidance shown
    expect(screen.getByText('Use the actions bar below to retry or cancel this run.')).toBeDefined();

    // Rate-limit guidance NOT shown
    expect(screen.queryByText('Click Retry to attempt again with a fresh retry budget.')).toBeNull();
  });

  it('does not render blocked card when phase is not blocked', () => {
    const data = makeRunData({ phase: 'executing' });

    render(<RunDetailContent data={data} />);

    expect(screen.queryByText('Run Blocked')).toBeNull();
  });
});
