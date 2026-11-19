// What the assistant works on (#5178): ALWAYS the same two halves, never
// remembered and never chosen by the owner's view. Records are live (it works
// with the real records the person sees). Structure goes to the changes
// waiting: every structural tool call becomes a card the owner reviews and
// applies (builder.ts); the assistant cannot apply, and has no tool that does.
import { STRUCTURAL_COMMANDS } from '../../../engine/index.ts';
import { waitingCount } from '../changes.ts';
import { isOwner, type Principal, runAs } from '../owner.ts';
import type { CallScope, Target } from '../target.ts';

/** What the system prompt says about where changes go. */
export interface ModeContext {
  /** Changes waiting for the owner now (0 for none). */
  waiting: number;
  scope: CallScope;
}

/** Records live, structure to the changes waiting, called by the assistant. */
export const ASSISTANT_SCOPE: Readonly<CallScope> = Object.freeze({
  records: 'live' as Target,
  structure: 'live' as Target,
  source: 'assistant' as const,
});

// The card a comment turn is about, per owner. A slot (not request state) so
// the local agent CLI, which calls tools in separate /mcp requests, sees it
// too. Set only by the owner's comment route for the length of that turn.
const revising = new Map<string, string>();

/** Run `fn` as the comment turn about `cardId` for `ownerId`. */
export async function withRevision<T>(
  ownerId: string,
  cardId: string,
  fn: () => Promise<T>,
): Promise<T> {
  revising.set(ownerId, cardId);
  try {
    return await fn();
  } finally {
    if (revising.get(ownerId) === cardId) revising.delete(ownerId);
  }
}

export const LIVE_MODE: ModeContext = { waiting: 0, scope: ASSISTANT_SCOPE };

/** The scope for `principal`, plus how many changes already wait. */
export async function assistantMode(
  principal: Principal,
): Promise<ModeContext> {
  if (!(await isOwner(principal))) return LIVE_MODE;
  const reviseCardId = revising.get(principal.id);
  return {
    waiting: await runAs(principal, () => waitingCount()).catch(() => 0),
    scope: reviseCardId
      ? { ...ASSISTANT_SCOPE, reviseCardId }
      : ASSISTANT_SCOPE,
  };
}

export async function assistantScope(principal: Principal): Promise<CallScope> {
  return (await assistantMode(principal)).scope;
}

/**
 * Builder tools that change structure: derived from the engine's total
 * STRUCTURAL_COMMANDS table (a command `undoTo` is the tool `app_undoto`), so a
 * new structural command cannot be missed here.
 */
export const STRUCTURAL_TOOLS: ReadonlySet<string> = new Set(
  Object.entries(STRUCTURAL_COMMANDS)
    .filter(([, structural]) => structural)
    .map(([type]) => `app_${type.toLowerCase()}`),
);
