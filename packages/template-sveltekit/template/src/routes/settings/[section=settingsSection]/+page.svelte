<script lang="ts">
  import { page } from '$app/state';
  import {
    ShellSettingsPage,
    type ShellSettingsSection,
  } from '@happyvertical/smrt-svelte/app';
  import { signOut } from '$lib/sign-out';
</script>

<svelte:head>
  <title>Settings · s-m-r-t app</title>
</svelte:head>

<!-- One built-in section (appearance, account, layout, shortcuts); the param matcher guarantees it. -->
<ShellSettingsPage
  basePath="/settings"
  section={page.params.section as ShellSettingsSection}
  onSignOut={signOut}
/>
