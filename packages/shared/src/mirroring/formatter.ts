/**
 * GitHub Comment Formatter for Mirroring
 *
 * Formats structured comments for GitHub issues to keep stakeholders
 * informed of run progress without needing the Conductor UI.
 */

// =============================================================================
// Types
// =============================================================================

export type MirrorEventType =
  | 'phase_transition'
  | 'plan_ready'
  | 'approval_decision'
  | 'failure';

export interface FormatCommentInput {
  eventType: MirrorEventType;
  runId: string;
  runNumber: number;
  fromPhase?: string;
  toPhase: string;
  timestamp: string;
  body: string;
  detailsContent?: string;
  detailsSummary?: string;
  conductorUrl?: string;
}

// =============================================================================
// Phase Icons
// =============================================================================

const PHASE_ICONS: Record<string, string> = {
  pending: '\u{1F7E1}',
  planning: '\u{1F504}',
  awaiting_plan_approval: '\u{1F4CB}',
  executing: '\u{26A1}',
  awaiting_review: '\u{1F50D}',
  blocked: '\u{1F6D1}',
  completed: '\u{2705}',
  cancelled: '\u{274C}',
};

// =============================================================================
// Constants
// =============================================================================

/** GitHub comment body limit: 65,536 chars. Leave 536 chars margin. */
export const GITHUB_COMMENT_MAX_CHARS = 65_000;

// =============================================================================
// Title Helpers
// =============================================================================

const EVENT_TITLES: Record<MirrorEventType, string> = {
  phase_transition: 'Phase Update',
  plan_ready: 'Plan Ready for Review',
  approval_decision: 'Operator Decision',
  failure: 'Run Blocked',
};

// =============================================================================
// Formatting
// =============================================================================

/**
 * Format a mirror event into a GitHub comment body.
 */
export function formatMirrorComment(input: FormatCommentInput): string {
  const icon = PHASE_ICONS[input.toPhase] ?? '\u{2139}\u{FE0F}';
  const title = EVENT_TITLES[input.eventType] ?? 'Update';

  const parts: string[] = [];

  // Header
  parts.push(`### ${icon} ${title} | Run #${input.runNumber}`);
  parts.push('');

  // Body
  parts.push(input.body);

  // Details section (collapsible)
  if (input.detailsContent !== undefined && input.detailsContent.trim() !== '') {
    const summary = input.detailsSummary ?? 'Details';
    parts.push('');
    parts.push('<details>');
    parts.push(`<summary>${summary}</summary>`);
    parts.push('');
    parts.push(input.detailsContent);
    parts.push('');
    parts.push('</details>');
  }

  // Footer
  parts.push('');
  parts.push('---');
  const conductorLink = input.conductorUrl !== undefined
    ? `[Conductor](${input.conductorUrl}/runs/${input.runId})`
    : 'Conductor';
  parts.push(`*${conductorLink} | ${input.timestamp}*`);

  return parts.join('\n');
}

/**
 * Truncate a formatted comment to fit within GitHub's character limit.
 *
 * If over the limit, truncates the details content section and appends
 * a truncation notice. Preserves the header, body, and footer.
 */
export function truncateComment(
  comment: string,
  maxChars: number = GITHUB_COMMENT_MAX_CHARS,
): string {
  if (comment.length <= maxChars) {
    return comment;
  }

  const truncationNotice = '\n\n... (truncated, see Conductor UI for full details)';

  // Try to find the details section and truncate within it
  const detailsStart = comment.indexOf('<details>');
  const detailsEnd = comment.indexOf('</details>');

  if (detailsStart !== -1 && detailsEnd !== -1) {
    const beforeDetails = comment.substring(0, detailsStart);
    const afterDetails = comment.substring(detailsEnd + '</details>'.length);
    const closingTag = '\n\n</details>';
    const overhead = beforeDetails.length + truncationNotice.length + closingTag.length + afterDetails.length;
    const availableForDetails = maxChars - overhead;

    if (availableForDetails > 100) {
      const detailsSection = comment.substring(detailsStart, detailsEnd);
      const truncatedDetails = detailsSection.substring(0, availableForDetails);
      return beforeDetails + truncatedDetails + truncationNotice + closingTag + afterDetails;
    }
  }

  // Fallback: simple truncation
  const fallbackLength = maxChars - truncationNotice.length;
  return comment.substring(0, fallbackLength) + truncationNotice;
}

/**
 * Format multiple coalesced events into a single comment.
 */
export function formatCoalescedComment(
  runNumber: number,
  events: Array<{ timestamp: string; body: string }>,
  conductorUrl?: string,
  runId?: string,
): string {
  const parts: string[] = [];

  parts.push(`### Phase Updates | Run #${runNumber}`);
  parts.push('');

  for (const event of events) {
    parts.push(`**${event.timestamp}** ${event.body}`);
    parts.push('');
  }

  parts.push('---');
  const conductorLink = conductorUrl !== undefined && runId !== undefined
    ? `[Conductor](${conductorUrl}/runs/${runId})`
    : 'Conductor';
  parts.push(`*${conductorLink} | ${new Date().toISOString()}*`);

  return parts.join('\n');
}
