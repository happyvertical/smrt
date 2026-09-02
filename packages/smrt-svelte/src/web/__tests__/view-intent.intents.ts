/**
 * A worked example of the `Foo.intents.ts` sidecar convention (#2588).
 *
 * Every declaration below is a module-scope `defineIntent({ ... })` call with
 * a single object literal — no spreads, no conditionals, no computed values —
 * in a `.ts` module, which is exactly the form #2591's scanner matches
 * without evaluating this file.
 */

import { defineIntent } from '@happyvertical/smrt-web/intents';

export const revealNotesIntent = defineIntent({
  id: 'fixture.reveal_notes',
  description: 'Scroll the notes field into view',
  capability: { effect: 'read', idempotent: true, openWorld: false },
  target: { registry: 'control', action: 'reveal' },
});

export const stageNotesIntent = defineIntent({
  id: 'fixture.stage_notes',
  description: 'Propose a value for the notes field',
  capability: { effect: 'write', idempotent: true, openWorld: false },
  inputSchema: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
  },
  target: { registry: 'control', action: 'stage' },
});

/** No `capability` at all — classifies fail-closed as destructive. */
export const clearNotesIntent = defineIntent({
  id: 'fixture.clear_notes',
  description: 'Clear the notes field',
  target: { registry: 'control', action: 'clear' },
});

export const nextPageIntent = defineIntent({
  id: 'fixture.next_page',
  description: 'Advance the orders table by one page',
  capability: { effect: 'read', idempotent: false, openWorld: false },
  target: { registry: 'dataSurface', controlId: 'next-page', kind: 'table' },
});
