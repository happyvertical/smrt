/**
 * Playbooks for the runtime-profile reference workload (#2591).
 *
 * A playbook is a script the agent follows step by step, never a call — every
 * step is authorized independently — so what parity has to prove is that the
 * PLAN is the same under every profile, down to the step order and the
 * qualified model/action pair each step names.
 */

import { definePlaybook } from '@happyvertical/smrt-playbooks';

export const prepareWorkItemForReview = definePlaybook({
  key: 'reference.prepare_for_review',
  title: 'Prepare a work item for review',
  description:
    'Prepare the focused work item for review and reveal it in the archived tab',
  steps: [
    {
      kind: 'operation',
      model: '@smrt-fixtures/runtime-profile-reference:ReferenceWorkItem',
      action: 'prepareForReview',
    },
    { kind: 'intent', id: 'reference.reveal_archived' },
  ],
});

export const archiveWorkItem = definePlaybook({
  key: 'reference.archive',
  title: 'Archive a work item',
  description: 'Archive the focused work item',
  planes: ['browser', 'server'],
  steps: [
    {
      kind: 'operation',
      model: '@smrt-fixtures/runtime-profile-reference:ReferenceWorkItem',
      action: 'archive',
    },
  ],
});
