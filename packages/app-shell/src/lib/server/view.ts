// The owner's view choice: which copy of the app the content shows while a
// draft is open. It is a per-owner (user-scope) member of the non-secret
// `assistant` preference. The UI reads it to pick what to show; EVERY request
// still names its copy (target.ts): this value is only what the server uses
// when it must choose for the owner (the assistant's record tools).

import { EngineError } from '@happyvertical/smrt-app-engine';
import { createPreferenceStore } from '@happyvertical/smrt-preferences';
import { asSettingsOwner } from './agent-cli/service.ts';
import {
  ASSISTANT_PREFERENCE_KIND,
  ASSISTANT_PREFERENCE_SURFACE,
  type AssistantPreferenceStore,
  type AssistantPreferences,
} from './agent-cli/settings.ts';
import { getDraftSlot, getShellDb } from './host.ts';
import type { Principal } from './owner.ts';
import { isTarget, type Target } from './target.ts';

async function store(): Promise<AssistantPreferenceStore> {
  return createPreferenceStore({
    db: await getShellDb(),
  }) as unknown as AssistantPreferenceStore;
}

/** The stored choice, ignoring whether a draft exists. */
async function stored(owner: Principal): Promise<Target> {
  return asSettingsOwner(owner, async () => {
    const state = await (await store()).load(
      ASSISTANT_PREFERENCE_KIND,
      ASSISTANT_PREFERENCE_SURFACE,
    );
    const view = (state.user?.payload as AssistantPreferences | null)?.view;
    return view === 'draft' ? 'draft' : 'live';
  });
}

/**
 * What the owner is looking at: `draft` only while a draft is open AND usable,
 * otherwise `live` whatever was stored (a stale `draft` never points at a copy
 * that is gone).
 */
export async function readView(owner: Principal): Promise<Target> {
  const slot = await getDraftSlot();
  if (!slot?.host) return 'live';
  return stored(owner);
}

/** Save the choice. `draft` needs a draft that is open and usable. */
export async function writeView(
  owner: Principal,
  view: unknown,
): Promise<Target> {
  if (!isTarget(view))
    throw new EngineError("view must be 'live' or 'draft'", 'invalid');
  if (view === 'draft') {
    const slot = await getDraftSlot();
    if (!slot)
      throw new EngineError('there is no draft open to look at', 'refused');
    if (!slot.host)
      throw new EngineError(
        `the draft "${slot.name}" cannot be used: ${slot.problem ?? 'it is not open'}`,
        'refused',
      );
  }
  await asSettingsOwner(owner, async () => {
    const s = await store();
    for (let attempt = 0; ; attempt++) {
      const state = await s.load(
        ASSISTANT_PREFERENCE_KIND,
        ASSISTANT_PREFERENCE_SURFACE,
      );
      const current =
        (state.user?.payload as AssistantPreferences | null) ?? {};
      const saved = await s.save(
        ASSISTANT_PREFERENCE_KIND,
        ASSISTANT_PREFERENCE_SURFACE,
        {
          scope: 'user',
          payload: { ...current, view },
          revision: state.user?.revision ?? null,
        },
      );
      if (saved.ok) return;
      if (saved.reason === 'conflict' && attempt < 2) continue;
      throw new Error(`the view could not be saved (${saved.reason})`);
    }
  });
  return view;
}
