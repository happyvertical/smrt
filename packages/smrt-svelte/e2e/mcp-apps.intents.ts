import { defineIntent } from '@happyvertical/smrt-web/intents';
export const stageIntent = defineIntent({
  id: 'mcpfixture.stage',
  description: 'Propose notes',
  capability: { effect: 'write', idempotent: true, openWorld: false },
  inputSchema: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
  },
  target: { registry: 'control', action: 'stage' },
});
export const nextIntent = defineIntent({
  id: 'mcpfixture.next',
  description: 'Next page',
  capability: { effect: 'read', idempotent: false, openWorld: false },
  target: { registry: 'dataSurface', controlId: 'next', kind: 'table' },
});
