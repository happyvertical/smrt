<script lang="ts">
import { ShellSettingsPage } from '@happyvertical/smrt-svelte/app';

// Host sections, each its own route under /settings.
const extraSections = [
  {
    id: 'assistant',
    label: 'Assistant',
    description: 'Connect Claude Code or Codex, or choose an API key.',
  },
  {
    id: 'inference',
    label: 'Inference',
    description: 'The assistant’s provider, API key and model.',
  },
];
</script>

<svelte:head>
  <title>Settings</title>
</svelte:head>

<!-- The section menu; each section is its own page under /settings. -->
<ShellSettingsPage basePath="/settings" {extraSections} />
