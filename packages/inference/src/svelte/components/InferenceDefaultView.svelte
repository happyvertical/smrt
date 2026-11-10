<script lang="ts">
/**
 * The default view of `InferenceSettingsPanel`: the whole screen for a
 * one-provider app. Mode, provider, base URL, key (set / not set, replace),
 * model (with local discovery), Test connection and the default tier.
 *
 * The key lives in its own `<form>`: it is never part of the choices form's
 * data, never held in component state, and the input is cleared as soon as
 * it is handed to `onSaveKey`. The host stores it through smrt-secrets and
 * only ever returns `keySet`.
 */
import { untrack } from 'svelte';
import type {
  InferenceConnectionRequest,
  InferenceDefaultsChange,
  InferenceDefaultsView,
  InferenceDiscoveryView,
  InferenceKeyChange,
  InferenceProviderView,
  InferenceSettingsMode,
  InferenceSettingsTier,
  InferenceTestResultView,
} from '../types.js';
import {
  INFERENCE_SETTINGS_MODES,
  INFERENCE_SETTINGS_TIERS,
} from '../types.js';

interface InferenceDefaultViewProps {
  defaults: InferenceDefaultsView;
  providers: InferenceProviderView[];
  discoveredModels: InferenceDiscoveryView[];
  busy: boolean;
  onSaveDefaults?: (change: InferenceDefaultsChange) => void;
  onSaveKey?: (change: InferenceKeyChange) => void | Promise<void>;
  onTestConnection?: (
    request: InferenceConnectionRequest,
  ) => Promise<InferenceTestResultView>;
  onDiscoverModels?: () => void;
}

const {
  defaults,
  providers,
  discoveredModels,
  busy,
  onSaveDefaults,
  onSaveKey,
  onTestConnection,
  onDiscoverModels,
}: InferenceDefaultViewProps = $props();

const MODE_LABELS: Record<InferenceSettingsMode, string> = {
  byo: 'Bring your own key',
  local: 'Local model server',
  hosted: 'Hosted by this app',
  off: 'Off',
};

let mode = $state<InferenceSettingsMode>(untrack(() => defaults.mode ?? 'byo'));
let provider = $state(untrack(() => defaults.provider ?? ''));
let baseUrl = $state(untrack(() => defaults.baseUrl ?? ''));
let model = $state(untrack(() => defaults.model ?? ''));
let defaultTier = $state<InferenceSettingsTier>(
  untrack(() => defaults.defaultTier ?? 'good'),
);
let keySavedFor = $state<string | null>(null);
let keyError = $state<string | null>(null);
let testing = $state(false);
let testResult = $state<InferenceTestResultView | null>(null);

const needsProvider = $derived(mode === 'byo' || mode === 'local');
const visibleProviders = $derived(
  mode === 'local' ? providers.filter((option) => option.local) : providers,
);
const selected = $derived(providers.find((option) => option.id === provider));
const keySet = $derived(
  keySavedFor === provider ||
    (defaults.keySet === true && (defaults.provider ?? '') === provider),
);
const discovered = $derived(
  discoveredModels.flatMap((entry) =>
    entry.models.map((id) => ({ id, service: entry.service })),
  ),
);

function connectionRequest(): InferenceConnectionRequest {
  const request: InferenceConnectionRequest = {};
  if (selected?.kind === 'preset') request.preset = selected.id;
  else if (provider) request.provider = provider;
  if (baseUrl.trim()) request.baseUrl = baseUrl.trim();
  if (model.trim()) request.model = model.trim();
  return request;
}

function saveChoices(event: SubmitEvent): void {
  event.preventDefault();
  if (!onSaveDefaults) return;
  const change: InferenceDefaultsChange = { mode, defaultTier };
  if (needsProvider) {
    if (provider) change.provider = provider;
    if (baseUrl.trim()) change.baseUrl = baseUrl.trim();
    if (model.trim()) change.model = model.trim();
  }
  onSaveDefaults(change);
}

async function saveKey(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const input = form.elements.namedItem('apiKey') as HTMLInputElement | null;
  const key = input?.value ?? '';
  // Clear first: the value must not survive in the DOM whatever happens next.
  if (input) input.value = '';
  keyError = null;
  if (!onSaveKey || !provider || !key.trim()) return;
  const savedFor = provider;
  const change: InferenceKeyChange = { provider: savedFor, key };
  if (selected?.kind === 'preset') change.preset = selected.id;
  if (baseUrl.trim()) change.baseUrl = baseUrl.trim();
  try {
    await onSaveKey(change);
    keySavedFor = savedFor;
  } catch {
    keyError = 'The key was not saved.';
  }
}

async function testConnection(): Promise<void> {
  if (!onTestConnection) return;
  testing = true;
  testResult = null;
  try {
    testResult = await onTestConnection(connectionRequest());
  } catch {
    testResult = { reachable: false, detail: 'The test could not run.' };
  } finally {
    testing = false;
  }
}
</script>

<div class="smrt-inference-default-view__root" data-testid="inference-default-view">
  <form class="smrt-inference-default-view__form" data-smrt-part="form" onsubmit={saveChoices} data-testid="inference-choices-form">
    <fieldset class="smrt-inference-default-view__modes" data-smrt-part="list" disabled={busy}>
      <legend>Inference</legend>
      {#each INFERENCE_SETTINGS_MODES as option (option)}
        <label class="smrt-inference-default-view__radio" data-smrt-part="radio">
          <input type="radio" name="mode" value={option} bind:group={mode} />
          {MODE_LABELS[option]}
        </label>
      {/each}
    </fieldset>

    {#if needsProvider}
      <label class="smrt-inference-default-view__field" data-smrt-part="field">
        <span>Provider</span>
        <select name="provider" bind:value={provider} disabled={busy}>
          <option value="">Choose a provider</option>
          {#each visibleProviders as option (option.id)}
            <option value={option.id}>{option.label}</option>
          {/each}
        </select>
      </label>

      <label class="smrt-inference-default-view__field" data-smrt-part="field">
        <span>Base URL</span>
        <input
          name="baseUrl"
          type="url"
          bind:value={baseUrl}
          placeholder={selected?.baseUrl ?? 'Provider default'}
          disabled={busy}
        />
      </label>

      <label class="smrt-inference-default-view__field" data-smrt-part="field">
        <span>Model</span>
        <input
          name="model"
          bind:value={model}
          list="isp-discovered-models"
          disabled={busy}
        />
        <datalist id="isp-discovered-models">
          {#each discovered as found (`${found.service}:${found.id}`)}
            <option value={found.id}>{found.service}</option>
          {/each}
        </datalist>
      </label>
      {#if onDiscoverModels}
        <button type="button" class="smrt-inference-default-view__link" data-smrt-part="link" onclick={() => onDiscoverModels?.()} disabled={busy}>
          Find local models
        </button>
      {/if}
    {/if}

    <label class="smrt-inference-default-view__field" data-smrt-part="field">
      <span>Default tier</span>
      <select name="defaultTier" bind:value={defaultTier} disabled={busy}>
        {#each INFERENCE_SETTINGS_TIERS as tier (tier)}
          <option value={tier}>{tier}</option>
        {/each}
      </select>
    </label>

    <div class="smrt-inference-default-view__actions" data-smrt-part="actions">
      <button type="submit" disabled={busy || !onSaveDefaults}>Save</button>
      {#if needsProvider && onTestConnection}
        <button
          type="button"
          onclick={testConnection}
          disabled={busy || testing || !provider}
        >
          {testing ? 'Testing…' : 'Test connection'}
        </button>
      {/if}
    </div>
    {#if testResult}
      <p
        class="smrt-inference-default-view__result" data-smrt-part="message"
        class:smrt-inference-default-view__result-ok={testResult.reachable}
        role="status"
        data-testid="inference-test-result"
      >
        {testResult.reachable ? 'Connected' : testResult.skipped ? 'Not tested' : 'Failed'}:
        {testResult.detail}
      </p>
    {/if}
  </form>

  {#if needsProvider && provider && (selected?.requiresApiKey ?? true)}
    <!-- Remount on a provider or endpoint change: a typed key never carries
         over to another endpoint. -->
    {#key `${provider}\n${baseUrl.trim()}`}
    <form class="smrt-inference-default-view__key" data-smrt-part="panel" onsubmit={saveKey} autocomplete="off" data-testid="inference-key-form">
      <span class="smrt-inference-default-view__key-status" data-smrt-part="meta" data-testid="inference-key-status">
        API key: {keySet ? 'set' : 'not set'}
      </span>
      <label class="smrt-inference-default-view__field" data-smrt-part="field">
        <span>{keySet ? 'Replace key' : 'Add key'}</span>
        <input
          name="apiKey"
          type="password"
          autocomplete="off"
          spellcheck="false"
          disabled={busy || !onSaveKey}
        />
      </label>
      <button type="submit" disabled={busy || !onSaveKey}>
        {keySet ? 'Replace key' : 'Save key'}
      </button>
      <p class="smrt-inference-default-view__hint" data-smrt-part="hint">
        The key is stored on the server and only ever sent to this provider's endpoint.
      </p>
      {#if keyError}
        <p class="smrt-inference-default-view__result" data-smrt-part="message" role="alert">{keyError}</p>
      {/if}
    </form>
    {/key}
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-inference-default-view__root {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .smrt-inference-default-view__form,
  .smrt-inference-default-view__key {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .smrt-inference-default-view__modes {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    padding: 0;
    margin: 0;
  }
  .smrt-inference-default-view__modes legend {
    margin-bottom: 0.25rem;
  }
  .smrt-inference-default-view__radio {
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }
  .smrt-inference-default-view__field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .smrt-inference-default-view__field input,
  .smrt-inference-default-view__field select {
    padding: 0.4rem 0.5rem;
  }
  .smrt-inference-default-view__actions {
    display: flex;
    gap: 0.5rem;
  }
  .smrt-inference-default-view__link {
    align-self: flex-start;
  }
  .smrt-inference-default-view__hint,
  .smrt-inference-default-view__result {
    margin: 0;
  }
}

@layer smrt.theme {
  .smrt-inference-default-view__modes {
    border: none;
  }
  .smrt-inference-default-view__modes legend {
    font-weight: 600;
  }
  .smrt-inference-default-view__field {
    font-size: 0.875rem;
  }
  .smrt-inference-default-view__field input,
  .smrt-inference-default-view__field select {
    border: var(--smrt-hairline);
    border-radius: 0.375rem;
    background: var(--smrt-color-surface);
    color: inherit;
    font: inherit;
  }
  .smrt-inference-default-view__key-status {
    font-weight: 600;
  }
  .smrt-inference-default-view__hint,
  .smrt-inference-default-view__result {
    font-size: 0.8125rem;
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-inference-default-view__result-ok {
    color: var(--smrt-color-success, inherit);
  }
}

</style>
