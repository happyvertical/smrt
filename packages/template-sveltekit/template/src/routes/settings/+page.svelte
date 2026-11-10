<script lang="ts">
  import { ShellSettingsPage } from '@happyvertical/smrt-svelte/app';

  // Host sections, each its own route under /settings.
  const extraSections = [
    {
      id: 'inference',
      label: 'Inference',
      description: 'Provider, model tiers, aliases, fusions and usage.',
    },
    {
      id: 'prompts',
      label: 'Prompts',
      description: 'Review and override the prompt text the app uses.',
    },
  ];
</script>

<svelte:head>
  <title>Settings · s-m-r-t app</title>
</svelte:head>

<!-- The section menu; each section is its own page under /settings. -->
<ShellSettingsPage basePath="/settings" {extraSections} />
