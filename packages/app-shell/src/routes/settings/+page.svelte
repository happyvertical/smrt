<script lang="ts">
import { ShellSettingsPage } from '@happyvertical/smrt-svelte/app';

// Host sections, each its own route under /settings.
const extraSections = [
  {
    id: 'import',
    label: 'Import',
    description: 'Choose the maximum workbook size in cells.',
  },
  {
    id: 'assistant',
    label: 'Assistant',
    description:
      'Choose what runs the assistant: Claude Code, Codex or an API key.',
  },
  {
    id: 'inference',
    label: 'Inference (advanced)',
    description:
      'Fine-tune the API provider, model and key the assistant uses when you chose an API key.',
  },
];
</script>

<svelte:head>
  <title>Settings</title>
</svelte:head>

<!-- The section menu; each section is its own page under /settings. -->
<ShellSettingsPage basePath="/settings" {extraSections} />
