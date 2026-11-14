<script lang="ts">
import {
  ShellSettingsPage,
  type ShellSettingsSection,
} from '@happyvertical/smrt-svelte/app';
import { page } from '$app/state';
import { signOut } from '$lib/ui/sign-out';
</script>

<svelte:head>
  <title>Settings</title>
</svelte:head>

<!-- One built-in section (appearance, account, layout, shortcuts); the param matcher guarantees it. -->
<ShellSettingsPage
  basePath="/settings"
  section={page.params.section as ShellSettingsSection}
  onSignOut={signOut}
/>
