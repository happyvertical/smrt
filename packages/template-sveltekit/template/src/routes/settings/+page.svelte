<script lang="ts">
  import { ShellSettingsPage } from '@happyvertical/smrt-svelte/app';
  import { signOut } from '$lib/sign-out';
</script>

<svelte:head>
  <title>Settings · s-m-r-t app</title>
</svelte:head>

<!-- Panel layout and WASD hotkeys, persisted through the shell's storageKey. -->
<ShellSettingsPage onSignOut={signOut} />
