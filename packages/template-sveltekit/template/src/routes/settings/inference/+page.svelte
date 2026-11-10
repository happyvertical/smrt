<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { ShellSettingsPage } from '@happyvertical/smrt-svelte/app';
  import { InferenceSettingsPanel } from '@happyvertical/smrt-inference/svelte';
  import { postSetting } from '$lib/settings-client';
  import type { PageProps } from './$types';

  let { data }: PageProps = $props();

  let busy = $state(false);
  let message = $state<string | null>(null);
  let error = $state<string | null>(null);
  let discovered = $state<
    { service: string; baseUrl: string; models: string[] }[]
  >([]);

  // Run one save: busy while pending, then the outcome as a flash.
  async function save(action: string, payload: unknown): Promise<void> {
    busy = true;
    message = error = null;
    const outcome = await postSetting(action, payload);
    busy = false;
    if (outcome.ok) message = 'Saved.';
    else error = outcome.error ?? 'The change was refused.';
  }

  // A probe returns a result instead of saving anything.
  async function probe(action: string, payload: unknown) {
    const outcome = await postSetting(action, payload, { reload: false });
    if (!outcome.ok || !outcome.data?.result) {
      return { reachable: false, detail: outcome.error ?? 'The probe failed.' };
    }
    return outcome.data.result as {
      reachable: boolean;
      detail: string;
    };
  }

  async function discover(): Promise<void> {
    const outcome = await postSetting('discoverModels', {}, { reload: false });
    discovered = (outcome.data?.discovered as typeof discovered) ?? [];
  }
</script>

<svelte:head>
  <title>Inference · Settings · s-m-r-t app</title>
</svelte:head>

<ShellSettingsPage basePath="/settings" title="Inference">
  <!-- The owner edits the whole app (app scope); a member without the
       permission reads it, and the server refuses their writes. -->
  <InferenceSettingsPanel
    defaults={data.defaults}
    providers={data.providers}
    discoveredModels={discovered}
    tiers={data.tiers}
    defaultTier={data.defaultTier}
    aliases={data.aliases}
    fusions={data.fusions}
    usage={data.usage}
    transcripts={data.transcripts}
    appEditable={data.canEdit}
    scope="app"
    contextKey={data.tenantId}
    {busy}
    {message}
    {error}
    onSaveDefaults={(change) => save('saveDefaults', change)}
    onTestConnection={(request) => probe('testConnection', request)}
    onDiscoverModels={discover}
    onSaveTier={(change) => save('saveTier', change)}
    onSaveDefaultTier={(change) => save('saveDefaultTier', change)}
    onSaveAlias={(change) => save('saveAlias', change)}
    onTestCandidate={(candidate) => probe('testCandidate', candidate)}
    onSaveFusion={(change) => save('saveFusion', change)}
    onSaveTranscripts={data.canEdit
      ? (change) => save('saveTranscripts', change)
      : undefined}
    onUsageGroupBy={(by) =>
      goto(`${page.url.pathname}?by=${by.join(',')}`, {
        keepFocus: true,
        noScroll: true,
        replaceState: true,
      })}
  />
</ShellSettingsPage>
