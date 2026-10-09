<script lang="ts">
import { Button } from '@happyvertical/smrt-ui/ui';
import '@happyvertical/smrt-ui/styles/tokens.css';
import ActivityList from '../src/components/workspace/admin-shell/ActivityList.svelte';
import ActivityTicker from '../src/components/workspace/admin-shell/ActivityTicker.svelte';
import AdminShell from '../src/components/workspace/admin-shell/AdminShell.svelte';
import { createShellState } from '../src/components/workspace/admin-shell/state.svelte.js';

const shell = createShellState({
  config: {
    top: false,
    left: false,
    right: false,
    bottom: {
      initial: 'collapsed',
      collapsedSize: '2.75rem',
      expandedSize: '18rem',
      presentation: 'overlay',
    },
  },
});
const count = Number(
  new URLSearchParams(window.location.search).get('count') ?? 1,
);
const params = new URLSearchParams(window.location.search);
const includeQueued = params.get('queued') === '1';
const includeTerminal = params.get('terminal') === '1';
for (let index = 0; index < count; index++)
  shell.upsertActivity({
    id: String(index),
    label: `Native process ${index + 1}`,
    status:
      includeQueued && index === 0
        ? 'queued'
        : includeTerminal && index === count - 1
          ? 'completed'
          : 'running',
    kind: 'job',
    scope: 'system',
    progress: 40 + index,
    message: `Activity detail ${index + 1}`,
  });
</script>
{#snippet systemBar()}<div class="bar"><Button variant="ghost" size="sm" aria-label="Toggle activity details" onclick={() => shell.togglePanel('bottom')}>Activities</Button><ActivityTicker activities={shell.activities} statuses={includeQueued ? ['queued', 'running'] : ['running']} label={includeQueued ? 'Active processes' : undefined} /></div>{/snippet}
{#snippet systemPanel()}<ActivityList filter={{status: includeQueued ? ['queued', 'running', 'completed'] : 'running'}} emptyLabel="No active processes" />{/snippet}
<AdminShell edgeToggles state={shell} title="Activity footer fixture" {systemBar} {systemPanel}><p>Workspace content</p></AdminShell>
<style>:global(body) { margin:0; font-family:sans-serif; } .bar { display:flex; align-items:center; width:100%; min-width:0; gap:0.5rem; }</style>
