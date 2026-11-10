<script lang="ts">
import type { ShellState } from '../../workspace/admin-shell/state.svelte.js';
import AppShell from '../AppShell.svelte';
import ShellSettingsPage from '../ShellSettingsPage.svelte';
import ShellStateProbe from './shell-state-probe.svelte';

let {
  chrome = true,
  onShell,
  edgeToggles = false,
  hotkeys,
  layoutEditing = true,
  user = { id: 'u1', name: 'Ada Owner', email: 'ada@example.com' },
  signOutHref,
  onSignOut,
}: {
  chrome?: boolean;
  onShell?: (shell: ShellState) => void;
  edgeToggles?: boolean;
  hotkeys?: boolean;
  layoutEditing?: boolean;
  user?: { id: string; name: string; email: string } | null;
  signOutHref?: string;
  onSignOut?: () => void | Promise<void>;
} = $props();
</script>

<AppShell
  {chrome}
  {edgeToggles}
  {hotkeys}
  {layoutEditing}
  user={user as never}
  config={{ left: { initial: 'expanded' } }}
>
  {#if onShell}<ShellStateProbe {onShell} />{/if}
  <ShellSettingsPage {signOutHref} {onSignOut} />
</AppShell>
