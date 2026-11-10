<script lang="ts">
import { ShellSettingsPage } from '@happyvertical/smrt-svelte/app';
import ConnectAi from '$lib/components/ConnectAi.svelte';
</script>

<svelte:head>
  <title>Assistant · Settings</title>
</svelte:head>

<ShellSettingsPage basePath="/settings" title="Assistant">
  <p>
    Choose what runs the assistant: the Claude Code you already have installed,
    your ChatGPT plan, or an API key. Codex is under Advanced.
  </p>
  <ConnectAi variant="settings" advancedHref="/settings/inference" />
  <p class="again">
    <a class="sh-link" href="/welcome">Run the welcome steps again</a>
  </p>
</ShellSettingsPage>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .again {
    margin-block-start: var(--smrt-spacing-lg, 1rem);
  }
}
</style>
