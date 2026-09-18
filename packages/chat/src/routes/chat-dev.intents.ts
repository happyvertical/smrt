/**
 * Declared view intent for the dev workbench's draft form (#2588).
 *
 * Declared at MODULE SCOPE in a `.ts` sidecar, never inline in a `.svelte` file:
 * that is the shape #2591's scanner can read statically, and the repo convention
 * for an agent-addressable interaction. The binding that mounts it lives in
 * `+page.svelte`, next to the form whose control it names.
 *
 * `capability.effect: 'write'` is load-bearing. An UNdeclared capability
 * classifies fail-closed as `destructive`, and the default exposure policy is
 * read-only, so a `stage` intent with no declaration — or one declaring `read` —
 * would never register. The binding passes `effects: ['read', 'write']` for the
 * same reason.
 *
 * Execution dispatches exactly one registry command with `source: 'agent'`, so
 * a staged value stays a PROPOSAL: it lands in `StagedControlReview` and a human
 * applies it. Nothing here reaches REST.
 */
import { defineIntent } from '@happyvertical/smrt-web/intents';

export const stageDraftSubjectIntent = defineIntent({
  id: 'chatdev.stage_draft_subject',
  description:
    'Stage a subject line into the dev workbench draft form. The value is a proposal: a human reviews and applies it.',
  capability: { effect: 'write', idempotent: true, openWorld: false },
  // REQUIRED for the tool to be callable. `compileViewIntentToolSpec` passes a
  // declaration's `inputSchema` through verbatim, and `buildControlCommand`
  // throws `IntentArgumentError('value')` for a `stage` with no `value` — so a
  // declaration without this registers a tool that advertises no parameters and
  // fails at call time with "Failed to parse input arguments".
  inputSchema: {
    type: 'object',
    properties: {
      value: {
        type: 'string',
        description: 'Proposed subject line to stage',
      },
    },
    required: ['value'],
  },
  target: {
    registry: 'control',
    action: 'stage',
    formId: 'chat-dev-draft',
    controlId: 'draft-subject',
  },
});
