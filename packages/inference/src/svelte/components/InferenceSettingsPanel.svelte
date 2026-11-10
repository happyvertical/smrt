<script lang="ts">
/**
 * InferenceSettingsPanel — the shared inference settings surface (#4754).
 *
 * Purely presentational, like smrt-prompts' `PromptSettingsPanel`: rows and
 * callbacks in, no fetching, no authorization decision. The host loads rows
 * with `InferenceSettingsService` (`@happyvertical/smrt-inference/server`)
 * and wires each callback to its own permission-checked server action.
 *
 * The default view is the whole screen for a one-provider app. Advanced
 * (tier ladder, `auto`'s default tier, aliases, fusions, transcripts) is collapsed and
 * not rendered until opened. Keys leave only through `onSaveKey`; the panel
 * never receives one back (`defaults.keySet` says whether one is stored).
 */
import type {
  InferenceAliasChange,
  InferenceAliasView,
  InferenceCandidateView,
  InferenceConnectionRequest,
  InferenceDefaultsChange,
  InferenceDefaultsView,
  InferenceDefaultTierChange,
  InferenceDefaultTierView,
  InferenceDiscoveryView,
  InferenceFusionChange,
  InferenceFusionView,
  InferenceKeyChange,
  InferenceProviderView,
  InferenceSettingsScope,
  InferenceSettingsTier,
  InferenceTestResultView,
  InferenceTierChange,
  InferenceTierView,
  InferenceTranscriptLinkFilters,
  InferenceTranscriptSettingsChange,
  InferenceTranscriptSettingsView,
  InferenceUsageDimension,
  InferenceUsageView,
} from '../types.js';
import {
  defaultTierRevertPreview,
  INFERENCE_SETTINGS_TIERS,
  inferenceLevelLabel,
  isRefAllowed,
} from '../types.js';
import InferenceAliasEditor from './InferenceAliasEditor.svelte';
import InferenceDefaultView from './InferenceDefaultView.svelte';
import InferenceFusionList from './InferenceFusionList.svelte';
import InferenceTierRow from './InferenceTierRow.svelte';
import InferenceTranscriptSettings from './InferenceTranscriptSettings.svelte';
import InferenceUsageTable from './InferenceUsageTable.svelte';

export interface InferenceSettingsPanelProps {
  /** The current user (or tenant) choices for the default view. */
  defaults?: InferenceDefaultsView;
  /** Provider choices (`InferenceSettingsService.listProviderOptions()`). */
  providers?: InferenceProviderView[];
  /** Local discovery results, when the host ran the #4674 probe. */
  discoveredModels?: InferenceDiscoveryView[];
  /** Tier rows (`listInferenceSettings()`). */
  tiers?: InferenceTierView[];
  /** `auto`'s default tier (`getDefaultTierSetting()`). */
  defaultTier?: InferenceDefaultTierView | null;
  /** Aliases (`listInferenceAliases()`). */
  aliases?: InferenceAliasView[];
  /** Fusions (`listInferenceFusions()`); render-only dependency on #4753. */
  fusions?: InferenceFusionView[];
  /** Usage report (`usage()`); the Usage tab shows when this or `onUsageGroupBy` is set. */
  usage?: InferenceUsageView | null;
  /**
   * The app's transcript setting (`getTranscriptSettings()`, #4781), shown
   * in Advanced and, when off, as a status line in the Usage tab.
   */
  transcripts?: InferenceTranscriptSettingsView | null;
  /**
   * The host is a platform admin that may change app-level settings
   * (#4781). Only then is the transcript setting editable (with
   * `onSaveTranscripts`); tenants cannot override it. Default `false`.
   */
  appEditable?: boolean;
  /**
   * The host's transcript route for a Usage-tab row (#4781). Rows with
   * stored transcripts link their count and outcome labels there; the panel
   * renders no transcript content.
   */
  transcriptHref?: (
    filters: InferenceTranscriptLinkFilters,
  ) => string | null | undefined;
  /**
   * Which scope Advanced edits write. `tenant` restricts choices to the
   * allow-list (display only; the server enforces it) and makes aliases and
   * fusions read-only (they are app-scope definitions).
   */
  scope?: InferenceSettingsScope;
  /** Open Advanced on first render. Default `false`. */
  advancedOpen?: boolean;
  /** Disable every control while a save is in flight. */
  busy?: boolean;
  message?: string | null;
  error?: string | null;
  /**
   * Identity of what is being edited (tenant or user id). Unsaved edits are
   * discarded whenever it changes, or, when omitted, whenever `tiers` or
   * `defaults` is replaced (a reloaded server load).
   */
  contextKey?: unknown;
  onSaveDefaults?: (change: InferenceDefaultsChange) => void;
  /** The only way a key leaves the panel. The host stores it through smrt-secrets. */
  onSaveKey?: (change: InferenceKeyChange) => void | Promise<void>;
  onTestConnection?: (
    request: InferenceConnectionRequest,
  ) => Promise<InferenceTestResultView>;
  onDiscoverModels?: () => void;
  onSaveTier?: (change: InferenceTierChange) => void;
  onSaveDefaultTier?: (change: InferenceDefaultTierChange) => void;
  onSaveAlias?: (change: InferenceAliasChange) => void;
  onTestCandidate?: (
    candidate: InferenceCandidateView,
  ) => Promise<InferenceTestResultView>;
  onSaveFusion?: (change: InferenceFusionChange) => void;
  onUsageGroupBy?: (by: InferenceUsageDimension[]) => void;
  /** Writes the app row (never a tenant row). Used only with `appEditable`. */
  onSaveTranscripts?: (change: InferenceTranscriptSettingsChange) => void;
}

const {
  defaults = {},
  providers = [],
  discoveredModels = [],
  tiers = [],
  defaultTier = null,
  aliases = [],
  fusions = [],
  usage = null,
  transcripts = null,
  appEditable = false,
  transcriptHref,
  scope = 'app',
  advancedOpen = false,
  busy = false,
  message = null,
  error = null,
  contextKey,
  onSaveDefaults,
  onSaveKey,
  onTestConnection,
  onDiscoverModels,
  onSaveTier,
  onSaveDefaultTier,
  onSaveAlias,
  onTestCandidate,
  onSaveFusion,
  onUsageGroupBy,
  onSaveTranscripts,
}: InferenceSettingsPanelProps = $props();

let tab = $state<'settings' | 'usage'>('settings');
// svelte-ignore state_referenced_locally
let advanced = $state(advancedOpen);

const showUsage = $derived(usage !== null || onUsageGroupBy !== undefined);
const definitionsEditable = $derived(scope === 'app');
// Remount on a context change so unsaved edits never cross tenants/users.
const defaultsKey = $derived(contextKey ?? defaults);
const advancedKey = $derived(contextKey ?? tiers);

function saveDefaultTier(event: SubmitEvent): void {
  event.preventDefault();
  if (!onSaveDefaultTier) return;
  const value = String(
    new FormData(event.currentTarget as HTMLFormElement).get('autoTier') ?? '',
  );
  onSaveDefaultTier({
    scope,
    tier: value === '' ? null : (value as InferenceSettingsTier),
  });
}

function tierAllowed(tier: InferenceSettingsTier): boolean {
  return (
    scope !== 'tenant' ||
    isRefAllowed(`tier:${tier}`, defaultTier?.tenantAllowList)
  );
}
</script>

<section class="smrt-inference-settings-panel__root" data-testid="inference-settings-panel" data-smrt-component="InferenceSettingsPanel">
  {#if message}<p class="smrt-inference-settings-panel__flash" data-smrt-part="message" role="status">{message}</p>{/if}
  {#if error}<p class="smrt-inference-settings-panel__flash smrt-inference-settings-panel__flash-error" data-smrt-part="message" role="alert">{error}</p>{/if}

  {#if showUsage}
    <div class="smrt-inference-settings-panel__tabs" data-smrt-part="list" role="tablist">
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'settings'}
        onclick={() => (tab = 'settings')}
      >
        Settings
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'usage'}
        onclick={() => (tab = 'usage')}
      >
        Usage
      </button>
    </div>
  {/if}

  {#if tab === 'usage' && showUsage}
    <div role="tabpanel">
      <InferenceUsageTable
        {usage}
        {busy}
        transcriptsEnabled={transcripts ? transcripts.enabled : null}
        {transcriptHref}
        {onUsageGroupBy}
      />
    </div>
  {:else}
    <div role={showUsage ? 'tabpanel' : undefined} class="smrt-inference-settings-panel__settings" data-smrt-part="body">
      {#key defaultsKey}
        <InferenceDefaultView
          {defaults}
          {providers}
          {discoveredModels}
          {busy}
          {onSaveDefaults}
          {onSaveKey}
          {onTestConnection}
          {onDiscoverModels}
        />
      {/key}

      <button
        type="button"
        class="smrt-inference-settings-panel__advanced-toggle" data-smrt-part="trigger"
        aria-expanded={advanced}
        aria-controls="isp-advanced"
        onclick={() => (advanced = !advanced)}
      >
        Advanced
      </button>

      {#if advanced}
        <div id="isp-advanced" class="smrt-inference-settings-panel__advanced" data-smrt-part="panel" data-testid="inference-advanced">
          {#key advancedKey}
            <section class="smrt-inference-settings-panel__section" data-smrt-part="group">
              <h3>Tier ladder</h3>
              {#each tiers as row (row.tier)}
                <InferenceTierRow
                  {row}
                  {scope}
                  {providers}
                  {aliases}
                  {fusions}
                  {busy}
                  {onSaveTier}
                />
              {:else}
                <p class="smrt-inference-settings-panel__hint" data-smrt-part="description">No tier rows were provided.</p>
              {/each}
            </section>

            {#if defaultTier}
              <section class="smrt-inference-settings-panel__section" data-smrt-part="group">
                <h3><code>auto</code> default tier</h3>
                <form class="smrt-inference-settings-panel__auto" data-smrt-part="field" onsubmit={saveDefaultTier} data-testid="inference-auto-tier">
                  <span>
                    Now {defaultTier.effectiveTier} ({inferenceLevelLabel(defaultTier.supplyingLevel)})
                  </span>
                  <label>
                    <span class="smrt-inference-settings-panel__hint" data-smrt-part="description">auto resolves to</span>
                    <select
                      name="autoTier"
                      disabled={busy}
                      value={(scope === 'app' ? defaultTier.appTier : defaultTier.tenantTier) ?? ''}
                    >
                      <option value="">Inherit ({defaultTierRevertPreview(defaultTier, scope)})</option>
                      {#each INFERENCE_SETTINGS_TIERS as tier (tier)}
                        <option value={tier} disabled={!tierAllowed(tier)}>{tier}</option>
                      {/each}
                    </select>
                  </label>
                  <button type="submit" disabled={busy || !onSaveDefaultTier}>Save</button>
                </form>
              </section>
            {/if}

            <section class="smrt-inference-settings-panel__section" data-smrt-part="group">
              <h3>Aliases</h3>
              {#each aliases as alias (alias.name)}
                <InferenceAliasEditor
                  {alias}
                  editable={definitionsEditable && !!onSaveAlias}
                  {busy}
                  {onSaveAlias}
                  {onTestCandidate}
                />
              {:else}
                <p class="smrt-inference-settings-panel__hint" data-smrt-part="description">No aliases are defined.</p>
              {/each}
              {#if definitionsEditable && onSaveAlias}
                <InferenceAliasEditor
                  alias={{ name: '', candidates: [] }}
                  editable
                  isNew
                  {busy}
                  {onSaveAlias}
                  {onTestCandidate}
                />
              {/if}
            </section>

            <section class="smrt-inference-settings-panel__section" data-smrt-part="group">
              <h3>Fusions</h3>
              <InferenceFusionList
                {fusions}
                editable={definitionsEditable}
                {busy}
                {onSaveFusion}
              />
            </section>

            {#if transcripts}
              <section class="smrt-inference-settings-panel__section" data-smrt-part="group">
                <h3>Transcripts</h3>
                <InferenceTranscriptSettings
                  settings={transcripts}
                  editable={appEditable && !!onSaveTranscripts}
                  {busy}
                  {onSaveTranscripts}
                />
              </section>
            {/if}
          {/key}
        </div>
      {/if}
    </div>
  {/if}
</section>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-inference-settings-panel__root,
  .smrt-inference-settings-panel__settings,
  .smrt-inference-settings-panel__advanced {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .smrt-inference-settings-panel__tabs {
    display: flex;
    gap: 0.5rem;
  }
  .smrt-inference-settings-panel__flash {
    margin: 0;
    padding: 0.625rem 0.75rem;
  }
  .smrt-inference-settings-panel__advanced-toggle {
    align-self: flex-start;
  }
  .smrt-inference-settings-panel__section h3 {
    margin: 0 0 0.5rem;
  }
  .smrt-inference-settings-panel__auto {
    display: flex;
    gap: 0.75rem;
    align-items: flex-end;
    flex-wrap: wrap;
  }
  .smrt-inference-settings-panel__hint {
    margin: 0;
  }
}

@layer smrt.theme {
  .smrt-inference-settings-panel__tabs {
    border-bottom: var(--smrt-hairline);
  }
  .smrt-inference-settings-panel__tabs [aria-selected='true'] {
    font-weight: 600;
  }
  .smrt-inference-settings-panel__flash {
    border-radius: 0.375rem;
    background: var(--smrt-color-surface-variant);
  }
  .smrt-inference-settings-panel__flash-error {
    color: var(--smrt-color-error);
    background: var(--smrt-color-error-container);
  }
  .smrt-inference-settings-panel__section h3 {
    font-size: 1rem;
  }
  .smrt-inference-settings-panel__hint {
    font-size: 0.8125rem;
    color: var(--smrt-color-on-surface-variant);
  }
}

</style>
