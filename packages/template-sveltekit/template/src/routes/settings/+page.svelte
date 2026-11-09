<script lang="ts">
  import { ShellSettingsPage } from '@happyvertical/smrt-svelte/app';
</script>

<svelte:head>
  <title>Settings · s-m-r-t app</title>
</svelte:head>

<!-- The section menu; each section is its own page under /settings. -->
<ShellSettingsPage basePath="/settings" />
