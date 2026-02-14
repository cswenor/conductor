import { toast } from 'sonner';
import { getOperatorActionLabel } from '@/lib/labels';

export function toastActionResult(
  result: { success: boolean; error?: string; outcome?: string },
  action: string,
): void {
  if (result.success) {
    if (result.outcome === 'accepted') {
      toast.success('Approval recorded — waiting on remaining gates');
    } else if (result.outcome === 'already_decided') {
      toast.info('Already processed');
    } else {
      toast.success(getOperatorActionLabel(action));
    }
  } else if (result.outcome === 'stale_run') {
    toast.error('Run state changed — please refresh and try again');
  } else {
    toast.error(result.error ?? `Failed to ${action.replace(/_/g, ' ')}`);
  }
}
