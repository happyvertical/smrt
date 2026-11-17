// Pure rules behind the shell header's draft state (components/DraftBar.svelte).
// The header is on every page, so it says only what the owner can act on.

import type { DraftInfo } from './types.ts';

/** What the header shows for the current draft state. */
export type DraftBarPlan =
  /** No draft: one quiet way to start one. */
  | { kind: 'start' }
  /** A draft with nothing in it yet: the copy switch and a quiet way out. */
  | { kind: 'idle' }
  /** A draft with changes: switch, count, Discard, Review and publish. */
  | { kind: 'changes'; count: number }
  /** A draft that cannot be published: switch and Discard only. */
  | { kind: 'blocked' };

export function planDraftBar(
  draft: DraftInfo | null | undefined,
): DraftBarPlan {
  if (!draft) return { kind: 'start' };
  if (!draft.publishable) return { kind: 'blocked' };
  if (draft.changes > 0) return { kind: 'changes', count: draft.changes };
  return { kind: 'idle' };
}

/** "1 change" / "3 changes", the unpublished count in the header. */
export function describeChanges(count: number): string {
  return `${count} ${count === 1 ? 'change' : 'changes'}, not published`;
}

/**
 * Whether the header carries draft state at all: for the signed-in owner on
 * every page except the welcome steps and first-run setup, never in a plugin
 * view (the host app is the chrome there).
 */
export function showDraftBar(options: {
  owner: boolean;
  plugin: boolean;
  onboarding: boolean;
  pathname: string;
}): boolean {
  if (!options.owner || options.plugin || options.onboarding) return false;
  return !/^\/(setup|welcome)(\/|$)/.test(options.pathname);
}
