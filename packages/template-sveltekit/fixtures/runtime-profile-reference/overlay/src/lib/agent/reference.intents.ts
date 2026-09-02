/**
 * View intents for the runtime-profile reference workload (#2591).
 *
 * A `.ts` sidecar, not inline in a component, and a literal object in a
 * module-scope `defineIntent()` call — the only form the scanner can read
 * without evaluating anything. The cross-profile parity test asserts that this
 * surface is byte-identical under `local`, `self-hosted`, and `cloud`, exactly
 * as it already does for generated model tools.
 */

import { defineIntent } from '@happyvertical/smrt-web/intents';

export const revealArchivedWorkItems = defineIntent({
  id: 'reference.reveal_archived',
  description: 'Reveal the archived work items tab',
  capability: { effect: 'read', idempotent: true, openWorld: false },
  target: { registry: 'control', action: 'reveal', controlId: 'archived-tab' },
});

export const stageWorkItemPriority = defineIntent({
  id: 'reference.stage_priority',
  description: 'Stage a new priority on the focused work item for human review',
  capability: { effect: 'write', idempotent: true, openWorld: false },
  inputSchema: {
    type: 'object',
    properties: { priority: { type: 'integer' } },
    required: ['priority'],
  },
  target: {
    registry: 'control',
    action: 'stage',
    formId: 'reference-work-item',
    controlId: 'priority',
  },
});
