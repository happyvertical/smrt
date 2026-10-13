<script lang="ts">
import ShellDockTool from '../../workspace/admin-shell/ShellDockTool.svelte';
import AppShell from '../AppShell.svelte';
import type { DockToggle } from '../dock-toggle.js';

let {
  registered = true,
  ready = true,
  href,
  onpress,
  labelNotReady,
}: {
  registered?: boolean;
  ready?: boolean;
  href?: string;
  onpress?: DockToggle['onpress'];
  labelNotReady?: string;
} = $props();

// Local state so a test can flip `ready` after mount (reactivity check).
let liveReady = $state<boolean | undefined>(undefined);
const effectiveReady = $derived(liveReady ?? ready);
export function setReady(next: boolean): void {
  liveReady = next;
}

const toggles: DockToggle[] = $derived([
  {
    tool: 'assistant',
    label: 'Assistant',
    href,
    onpress,
    labelNotReady,
    ready: effectiveReady,
  },
]);
</script>

<AppShell dockToggles={toggles}>
  {#snippet dock()}
    {#if registered}
      <ShellDockTool id="assistant" label="Assistant" render={body} />
    {/if}
  {/snippet}
  <p>Main</p>
</AppShell>

{#snippet body()}<input aria-label="Ask" />{/snippet}
