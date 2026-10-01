<script lang="ts">
import { createDataSurfaceRegistry } from '@happyvertical/smrt-ui/data';
import {
  createControlInteractionRegistry,
  executeLocalControlCommand,
} from '@happyvertical/smrt-ui/forms';
import { Button } from '@happyvertical/smrt-ui/ui';
import { onMount } from 'svelte';
import { useMcpApp, useMcpAppIntent } from '../src/mcp-apps/index.js';
import { nextIntent, stageIntent } from './mcp-apps.intents.js';

const app = useMcpApp(() => ({
  hostWindow: parent,
  hostOrigin: 'http://127.0.0.1:47851',
  appInfo: { name: 'Svelte registry fixture', version: '1' },
}));
let value = $state('Original');
let proposed = $state(false);
let page = $state(1);
let refusal = $state('');
const identity = { formId: 'synthetic-review', controlId: 'notes' };
const controls = createControlInteractionRegistry();
const surfaces = createDataSurfaceRegistry();
const surfaceIdentity = {
  surfaceId: 'synthetic-opportunities',
  kind: 'table' as const,
};
const stage = useMcpAppIntent(stageIntent, {
  registry: 'control',
  registryPort: controls,
  identity,
});
const next = useMcpAppIntent(nextIntent, {
  registry: 'dataSurface',
  registryPort: surfaces,
  identity: surfaceIdentity,
});
onMount(() => {
  const unregisterControl = controls.register({
    identity,
    metadata: { kind: 'text', label: 'Notes', readable: true, writable: true },
    getValue: () => value,
    setValue: (next) => {
      value = String(next);
    },
  });
  const unregisterSurface = surfaces.register({
    descriptor: {
      version: 1,
      schemaVersion: 1,
      identity: surfaceIdentity,
      label: 'Synthetic opportunities',
      rowKey: 'id',
      columns: [{ id: 'id', label: 'ID', capabilities: ['read'] }],
      query: { modes: ['rows'], projectableColumnIds: ['id'] },
      controls: [{ id: 'next', label: 'Next page' }],
      actions: [],
      limits: { maxQueryRows: 10, maxQueryBytes: 1024, maxSelectionSize: 1 },
    },
    getSnapshot: () => ({ revision: page, state: { page } }),
    execute: () => {
      page += 1;
    },
  });
  Object.assign(window, { bindingFixture: { app, stage, next, controls } });
  return () => {
    unregisterControl();
    unregisterSurface();
  };
});
async function propose() {
  await stage({ value: 'Proposed' });
  proposed = true;
}
async function spoof() {
  const result = await controls.execute(
    { action: 'apply', identity, revision: 1 },
    { source: 'user', confirmed: true },
  );
  refusal = result.ok ? 'unexpectedly allowed' : result.reason;
}
async function apply(event: MouseEvent) {
  await executeLocalControlCommand(
    controls,
    { action: 'apply', identity, revision: 1 },
    event,
  );
}
</script>
<p>Bridge: {app.snapshot?.state ?? 'mounting'}</p>
<p>Value: {value}</p>
<p>Page: {page}</p>
<p>{refusal}</p>
<Button onclick={propose}>Propose</Button>
<Button onclick={() => next()}>Next page</Button>
<Button onclick={spoof}>Attempt synthetic approval</Button>
{#if proposed}<Button onclick={apply}>Apply reviewed proposal</Button>{/if}
