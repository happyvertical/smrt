// Which copy of the app the assistant works on, resolved from the owner's
// state at the moment of each call (never remembered between calls):
//
//   no draft open            structure live, records live: today's behaviour
//                            (a risky change becomes an Approval).
//   draft open, owner views  structure DRAFT (the assistant only builds in the
//   Live                     draft), records LIVE (it still works with the real
//                            records the person is looking at).
//   draft open, owner views  structure DRAFT, records DRAFT (test records).
//   Draft
//
// A draft that cannot be opened counts as no usable draft: structure stays on
// live and is refused there, by name, while the draft is open.
import { STRUCTURAL_COMMANDS } from '@happyvertical/smrt-app-engine';
import { getDraftSlot } from '../host.ts';
import { isOwner, type Principal } from '../owner.ts';
import { type CallScope, LIVE_SCOPE, type Target } from '../target.ts';
import { readView } from '../view.ts';

/** What the system prompt says about the copies. */
export interface ModeContext {
  /** The open draft's name, or null when none is open and usable. */
  draft: string | null;
  scope: CallScope;
}

export const LIVE_MODE: ModeContext = { draft: null, scope: LIVE_SCOPE };

/** The scope for `principal` now: live unless the owner has an open, usable draft. */
export async function assistantMode(
  principal: Principal,
): Promise<ModeContext> {
  if (!(await isOwner(principal))) return LIVE_MODE;
  const slot = await getDraftSlot();
  if (!slot?.host) return LIVE_MODE;
  const records: Target = await readView(principal);
  return { draft: slot.name, scope: { structure: 'draft', records } };
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

/**
 * The sentence that closes a turn that changed structure while a draft is
 * open: which copy it landed in. Null with no draft (today's replies).
 */
export function copyNote(mode: ModeContext): string | null {
  return mode.draft
    ? `I made that change in the draft "${mode.draft}", so the live app is unchanged until you publish.`
    : null;
}
