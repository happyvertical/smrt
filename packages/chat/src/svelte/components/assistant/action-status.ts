/**
 * Maps an `AssistantActionState.status` to `ToolCallDisplayData['status']`
 * (#2904 review, Copilot PR #2919 jAwua/jAwtb).
 *
 * Shared by `AssistantDock.svelte` and the demo route
 * (`packages/chat/src/routes/previews/assistant-dock/+page.svelte`) so both
 * status badges stay in sync — both previously fell through to `'success'`
 * while `status === 'previewing'`, showing "Completed" for an action whose
 * preview request (or, in the demo, apply request too) was still in flight
 * or about to fail.
 */
import type { AssistantActionState } from './create-assistant-dock-controller.svelte.js';

export function toolCallStatusForAction(
  status: AssistantActionState['status'],
): 'running' | 'success' | 'error' {
  if (status === 'failed') return 'error';
  if (status === 'previewing' || status === 'applying') return 'running';
  return 'success';
}
