/**
 * GitHub Issue Mirroring Module
 *
 * Posts structured comments on linked GitHub issues when runs progress.
 */

export { formatMirrorComment, truncateComment, formatCoalescedComment, GITHUB_COMMENT_MAX_CHARS } from './formatter.ts';
export type { MirrorEventType, FormatCommentInput } from './formatter.ts';

export { redactContent } from './redact-content.ts';

export { checkAndMirror, flushStaleDeferredEvents } from './rate-limiter.ts';
export type { MirrorResult, DeferredEvent, CoalesceContext } from './rate-limiter.ts';

export {
  mirrorPhaseTransition,
  mirrorPlanArtifact,
  mirrorApprovalDecision,
  mirrorFailure,
} from './mirror.ts';
export type { MirrorContext } from './mirror.ts';
