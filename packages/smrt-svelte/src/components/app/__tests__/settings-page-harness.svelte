<script lang="ts">
import type { ShellSettingsSection } from '../../workspace/admin-shell/settings-sections.js';
import type { ShellState } from '../../workspace/admin-shell/state.svelte.js';
import AppShell from '../AppShell.svelte';
import ShellSettingsPage from '../ShellSettingsPage.svelte';
import type { ShellSettingsMenuItem } from '../settings-menu-item.js';
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
  basePath,
  section,
  extraSections,
  withChildren = false,
}: {
  chrome?: boolean;
  onShell?: (shell: ShellState) => void;
  edgeToggles?: boolean;
  hotkeys?: boolean;
  layoutEditing?: boolean;
  user?: { id: string; name: string; email: string } | null;
  signOutHref?: string;
  onSignOut?: () => void | Promise<void>;
  basePath?: string;
  section?: ShellSettingsSection;
  extraSections?: ShellSettingsMenuItem[];
  withChildren?: boolean;
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
  {#if withChildren}
    <ShellSettingsPage {basePath} {section} {extraSections} title="Host section">
      <p data-testid="host-section">host content</p>
    </ShellSettingsPage>
  {:else}
    <ShellSettingsPage
      {signOutHref}
      {onSignOut}
      {basePath}
      {section}
      {extraSections}
    />
  {/if}
</AppShell>
