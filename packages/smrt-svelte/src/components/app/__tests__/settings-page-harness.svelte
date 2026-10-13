<script lang="ts">
import AppShell from '../AppShell.svelte';
import ShellSettingsPage from '../ShellSettingsPage.svelte';

let {
  edgeToggles = false,
  hotkeys,
  layoutEditing = true,
  user = { id: 'u1', name: 'Ada Owner', email: 'ada@example.com' },
  signOutHref,
  onSignOut,
}: {
  edgeToggles?: boolean;
  hotkeys?: boolean;
  layoutEditing?: boolean;
  user?: { id: string; name: string; email: string } | null;
  signOutHref?: string;
  onSignOut?: () => void | Promise<void>;
} = $props();
</script>

<AppShell
  {edgeToggles}
  {hotkeys}
  {layoutEditing}
  user={user as never}
  config={{ left: { initial: 'expanded' } }}
>
  <ShellSettingsPage {signOutHref} {onSignOut} />
</AppShell>
