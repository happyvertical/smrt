<script lang="ts">
  import { ShellSettingsPage } from '@happyvertical/smrt-svelte/app';
  import { PromptSettingsPanel } from '@happyvertical/smrt-prompts/svelte';
  import type { PageProps } from './$types';

  let { data, form }: PageProps = $props();
</script>

<svelte:head>
  <title>Prompts · Settings · s-m-r-t app</title>
</svelte:head>

<ShellSettingsPage basePath="/settings" title="Prompts">
  <!-- Each row is a plain form posting to ?/savePrompt, so saving works
       without client code; the page reloads with the stored text. -->
  <PromptSettingsPanel
    prompts={data.prompts}
    contextKey={data.tenantId}
    tenantLabel="This workspace"
    showApp={data.canEdit}
    appEditable={data.canEdit}
    appLabel="All workspaces"
    busy={!data.canEdit}
    formAction="?/savePrompt"
    message={form && 'message' in form ? form.message : null}
    error={form && 'error' in form ? form.error : null}
  />
</ShellSettingsPage>
