import { describe, it, expect } from 'vitest';
import {
  formatMirrorComment,
  truncateComment,
  formatCoalescedComment,
  GITHUB_COMMENT_MAX_CHARS,
} from './formatter.ts';

describe('formatMirrorComment', () => {
  const baseInput = {
    eventType: 'phase_transition' as const,
    runId: 'run_abc123',
    runNumber: 42,
    fromPhase: 'pending',
    toPhase: 'planning',
    timestamp: '2025-01-15T10:00:00Z',
    body: 'Run has started planning.',
  };

  it('formats a basic phase transition comment', () => {
    const result = formatMirrorComment(baseInput);

    expect(result).toContain('### \u{1F504} Phase Update | Run #42');
    expect(result).toContain('Run has started planning.');
    expect(result).toContain('*Conductor | 2025-01-15T10:00:00Z*');
  });

  it('includes correct phase icons', () => {
    const phases: Record<string, string> = {
      pending: '\u{1F7E1}',
      planning: '\u{1F504}',
      awaiting_plan_approval: '\u{1F4CB}',
      executing: '\u{26A1}',
      awaiting_review: '\u{1F50D}',
      blocked: '\u{1F6D1}',
      completed: '\u{2705}',
      cancelled: '\u{274C}',
    };

    for (const [phase, icon] of Object.entries(phases)) {
      const result = formatMirrorComment({ ...baseInput, toPhase: phase });
      expect(result).toContain(icon);
    }
  });

  it('uses info icon for unknown phases', () => {
    const result = formatMirrorComment({ ...baseInput, toPhase: 'unknown_phase' });
    expect(result).toContain('\u{2139}\u{FE0F}');
  });

  it('includes details section when provided', () => {
    const result = formatMirrorComment({
      ...baseInput,
      detailsContent: '## Implementation Plan\n\n1. Step one\n2. Step two',
      detailsSummary: 'View Plan',
    });

    expect(result).toContain('<details>');
    expect(result).toContain('<summary>View Plan</summary>');
    expect(result).toContain('## Implementation Plan');
    expect(result).toContain('</details>');
  });

  it('uses default details summary', () => {
    const result = formatMirrorComment({
      ...baseInput,
      detailsContent: 'Some details here',
    });

    expect(result).toContain('<summary>Details</summary>');
  });

  it('omits details section when content is empty', () => {
    const result = formatMirrorComment({
      ...baseInput,
      detailsContent: '',
    });

    expect(result).not.toContain('<details>');
  });

  it('omits details section when content is whitespace only', () => {
    const result = formatMirrorComment({
      ...baseInput,
      detailsContent: '   \n  ',
    });

    expect(result).not.toContain('<details>');
  });

  it('includes conductor URL link when provided', () => {
    const result = formatMirrorComment({
      ...baseInput,
      conductorUrl: 'https://conductor.example.com',
    });

    expect(result).toContain('[Conductor](https://conductor.example.com/runs/run_abc123)');
  });

  it('formats plan_ready event type', () => {
    const result = formatMirrorComment({
      ...baseInput,
      eventType: 'plan_ready',
      toPhase: 'awaiting_plan_approval',
    });

    expect(result).toContain('Plan Ready for Review');
    expect(result).toContain('\u{1F4CB}');
  });

  it('formats approval_decision event type', () => {
    const result = formatMirrorComment({
      ...baseInput,
      eventType: 'approval_decision',
      toPhase: 'executing',
    });

    expect(result).toContain('Operator Decision');
  });

  it('formats failure event type', () => {
    const result = formatMirrorComment({
      ...baseInput,
      eventType: 'failure',
      toPhase: 'blocked',
    });

    expect(result).toContain('Run Blocked');
    expect(result).toContain('\u{1F6D1}');
  });

  it('handles missing optional fields', () => {
    const result = formatMirrorComment({
      eventType: 'phase_transition',
      runId: 'run_abc123',
      runNumber: 1,
      toPhase: 'planning',
      timestamp: '2025-01-15T10:00:00Z',
      body: 'Transitioned.',
    });

    expect(result).toContain('Phase Update');
    expect(result).toContain('Transitioned.');
    expect(result).not.toContain('<details>');
  });
});

describe('truncateComment', () => {
  it('returns comment unchanged if within limit', () => {
    const comment = 'Short comment';
    expect(truncateComment(comment)).toBe(comment);
  });

  it('truncates to specified max chars', () => {
    const comment = 'x'.repeat(200);
    const result = truncateComment(comment, 100);
    expect(result.length).toBeLessThanOrEqual(100);
    expect(result).toContain('truncated');
  });

  it('enforces the GitHub 65K limit', () => {
    const longContent = 'x'.repeat(70_000);
    const comment = formatMirrorComment({
      eventType: 'plan_ready',
      runId: 'run_abc',
      runNumber: 1,
      toPhase: 'awaiting_plan_approval',
      timestamp: '2025-01-15T10:00:00Z',
      body: 'Plan ready',
      detailsContent: longContent,
    });

    const result = truncateComment(comment);
    expect(result.length).toBeLessThanOrEqual(GITHUB_COMMENT_MAX_CHARS);
    expect(result).toContain('truncated');
  });

  it('truncates within details section when possible', () => {
    const longDetails = 'y'.repeat(70_000);
    const comment = formatMirrorComment({
      eventType: 'plan_ready',
      runId: 'run_abc',
      runNumber: 1,
      toPhase: 'awaiting_plan_approval',
      timestamp: '2025-01-15T10:00:00Z',
      body: 'Plan ready',
      detailsContent: longDetails,
    });

    const result = truncateComment(comment);
    // Should still contain the header and footer
    expect(result).toContain('Plan Ready for Review');
    expect(result).toContain('truncated');
  });
});

describe('formatCoalescedComment', () => {
  it('formats multiple events into one comment', () => {
    const events = [
      { timestamp: '10:00', body: 'planning -> awaiting_plan_approval' },
      { timestamp: '10:01', body: 'Plan approved by operator' },
    ];

    const result = formatCoalescedComment(42, events);

    expect(result).toContain('Phase Updates | Run #42');
    expect(result).toContain('**10:00** planning -> awaiting_plan_approval');
    expect(result).toContain('**10:01** Plan approved by operator');
  });

  it('includes conductor URL when provided', () => {
    const result = formatCoalescedComment(
      1,
      [{ timestamp: '10:00', body: 'test' }],
      'https://example.com',
      'run_abc',
    );

    expect(result).toContain('[Conductor](https://example.com/runs/run_abc)');
  });

  it('handles single event', () => {
    const result = formatCoalescedComment(1, [
      { timestamp: '10:00', body: 'Single event' },
    ]);

    expect(result).toContain('**10:00** Single event');
  });
});
