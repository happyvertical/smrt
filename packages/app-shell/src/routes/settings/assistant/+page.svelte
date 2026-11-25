<script lang="ts">
import { ShellSettingsPage } from '@happyvertical/smrt-svelte/app';
import ConnectAi from '$lib/components/ConnectAi.svelte';

const { data }: { data?: { hosted?: boolean } } = $props();
</script>

<svelte:head>
  <title>Assistant · Settings</title>
</svelte:head>

<ShellSettingsPage basePath="/settings" title="Assistant">
  <p>
    {#if data?.hosted}
      The assistant runs on your own API key. Save one under Advanced.
    {:else}
      Choose what runs the assistant: the Claude Code you already have installed,
      your ChatGPT plan, or an API key. Codex is under Advanced.
    {/if}
  </p>
  <ConnectAi variant="settings" advancedHref="/settings/inference" />
  <p class="smrt-app-shell-assistant__again">
    <a class="smrt-app-shell__link" href="/welcome">Run the welcome steps again</a>
  </p>
</ShellSettingsPage>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;

@layer smrt.structure {
  .smrt-app-shell-assistant__again {
    margin-block-start: var(--smrt-spacing-lg, 1rem);
  }
}
</style>
