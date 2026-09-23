<script lang="ts">
/**
 * FeatureSettingsPanel — the shared feature-flag management surface.
 *
 * Purely presentational: it takes rows and callbacks. It does no fetching, and
 * it makes no authorization decision — the host decides who may see the panel
 * and who may write, and enforces that on the server (see
 * `FeatureSettingsService` and `FeatureOverrideService`). Rendering the global
 * column is a host decision too: apps with no platform-admin tier omit it.
 *
 * Each row renders as its own `<form>`, so a SvelteKit host can point
 * `formAction` at a form action and get a working screen with no client JS;
 * supplying `onSave` instead (or as well) intercepts the submit and hands the
 * change to the host.
 */
import { Badge, Button, Card } from '@happyvertical/smrt-ui/ui';
import type {
  FeatureSettingsChange,
  FeatureSettingsEffect,
  FeatureSettingsView,
} from '../types.js';
import {
  defaultOptionLabel,
  effectiveStateLabel,
  toFeatureSettingsEffect,
} from '../types.js';

export interface Props {
  /** The features to manage, in the order they should be rendered. */
  features?: FeatureSettingsView[];
  /** Column heading for the tenant-scope control. */
  tenantLabel?: string;
  /**
   * Render the global-scope column. Off by default: an app with no
   * platform-admin tier has nothing to put there.
   */
  showGlobal?: boolean;
  /**
   * Let the operator change the global column. Ignored unless `showGlobal`.
   * When false the column is rendered read-only, which is how a tenant admin
   * sees the platform default that their own override is layered on.
   */
  globalEditable?: boolean;
  /** Column heading for the global-scope control. */
  globalLabel?: string;
  /** Disable every control while a save is in flight. */
  busy?: boolean;
  /** Success text to show above the list. */
  message?: string | null;
  /** Error text to show above the list. */
  error?: string | null;
  /** Text for the empty state. */
  emptyMessage?: string;
  /** Label for each row's submit control. */
  saveLabel?: string;
  /**
   * SvelteKit form action for each row's `<form>` (e.g. `?/saveFeature`).
   * Omit when driving the panel entirely through {@link Props.onSave}.
   */
  formAction?: string;
  /**
   * Called with the requested change instead of submitting the form. The host
   * performs its own permission check and the write.
   */
  onSave?: (change: FeatureSettingsChange) => void;
}

const {
  features = [],
  tenantLabel = 'Tenant',
  showGlobal = false,
  globalEditable = false,
  globalLabel = 'Global',
  busy = false,
  message = null,
  error = null,
  emptyMessage = 'No features are registered yet. Definitions appear here once they are synced from code.',
  saveLabel = 'Save',
  formAction,
  onSave,
}: Props = $props();

/** Operator edits that have not been submitted yet, keyed by feature key. */
let drafts = $state<
  Record<
    string,
    { tenant?: FeatureSettingsEffect; global?: FeatureSettingsEffect }
  >
>({});

const globalIsEditable = $derived(showGlobal && globalEditable);
const canSubmit = $derived(!busy && (onSave != null || formAction != null));

function tenantDraft(feature: FeatureSettingsView): FeatureSettingsEffect {
  return (
    drafts[feature.featureKey]?.tenant ??
    toFeatureSettingsEffect(feature.tenantEffect)
  );
}

function globalDraft(feature: FeatureSettingsView): FeatureSettingsEffect {
  return (
    drafts[feature.featureKey]?.global ??
    toFeatureSettingsEffect(feature.globalEffect)
  );
}

function setDraft(
  featureKey: string,
  scope: 'tenant' | 'global',
  value: string,
): void {
  drafts = {
    ...drafts,
    [featureKey]: {
      ...drafts[featureKey],
      [scope]: toFeatureSettingsEffect(value),
    },
  };
}

function submit(event: SubmitEvent, feature: FeatureSettingsView): void {
  if (!onSave) return;
  event.preventDefault();
  onSave({
    featureKey: feature.featureKey,
    tenantEffect: tenantDraft(feature),
    ...(globalIsEditable ? { globalEffect: globalDraft(feature) } : {}),
  });
}

/** Read-only rendering of an override level that this operator cannot change. */
function readOnlyEffectLabel(
  effect: FeatureSettingsEffect,
  defaultEnabled: boolean,
): string {
  if (effect === 'enable') return 'Enabled';
  if (effect === 'disable') return 'Disabled';
  return defaultOptionLabel(defaultEnabled);
}
</script>

<section class="feature-settings" data-testid="feature-settings-panel">
  {#if message}
    <p class="fs-flash" role="status">{message}</p>
  {/if}
  {#if error}
    <p class="fs-flash fs-flash-error" role="alert">{error}</p>
  {/if}

  {#each features as feature (feature.featureKey)}
    <Card variant="outlined">
      <div class="fs-row">
        <div class="fs-copy">
          <div class="fs-title-row">
            <h3 class="fs-title">{feature.label || feature.featureKey}</h3>
            <Badge
              variant={feature.effectiveEnabled ? 'success' : 'default'}
              size="sm"
            >
              {effectiveStateLabel(feature.effectiveEnabled)}
            </Badge>
          </div>
          <p class="fs-description">{feature.description || feature.featureKey}</p>
          <code class="fs-key">{feature.featureKey}</code>
          {#if feature.packageName}
            <span class="fs-package">{feature.packageName}</span>
          {/if}
        </div>

        <form
          class="fs-controls"
          method="POST"
          action={formAction}
          onsubmit={(event) => submit(event, feature)}
        >
          <input type="hidden" name="featureKey" value={feature.featureKey} />

          {#if showGlobal}
            {#if globalIsEditable}
              <label class="fs-field">
                <span class="fs-field-label">{globalLabel}</span>
                <select
                  name="globalEffect"
                  disabled={busy}
                  onchange={(event) =>
                    setDraft(
                      feature.featureKey,
                      'global',
                      event.currentTarget.value,
                    )}
                >
                  <option
                    value="inherit"
                    selected={globalDraft(feature) === 'inherit'}
                  >
                    {defaultOptionLabel(feature.defaultEnabled)}
                  </option>
                  <option
                    value="enable"
                    selected={globalDraft(feature) === 'enable'}
                  >
                    Enable
                  </option>
                  <option
                    value="disable"
                    selected={globalDraft(feature) === 'disable'}
                  >
                    Disable
                  </option>
                </select>
              </label>
            {:else}
              <div class="fs-field">
                <span class="fs-field-label">{globalLabel}</span>
                <p class="fs-readonly">
                  {readOnlyEffectLabel(
                    globalDraft(feature),
                    feature.defaultEnabled,
                  )}
                </p>
              </div>
            {/if}
          {/if}

          <label class="fs-field">
            <span class="fs-field-label">{tenantLabel}</span>
            <select
              name="tenantEffect"
              disabled={busy}
              onchange={(event) =>
                setDraft(feature.featureKey, 'tenant', event.currentTarget.value)}
            >
              <option
                value="inherit"
                selected={tenantDraft(feature) === 'inherit'}
              >
                {defaultOptionLabel(feature.defaultEnabled)}
              </option>
              <option value="enable" selected={tenantDraft(feature) === 'enable'}>
                Enable
              </option>
              <option
                value="disable"
                selected={tenantDraft(feature) === 'disable'}
              >
                Disable
              </option>
            </select>
          </label>

          <Button type="submit" variant="primary" size="sm" disabled={!canSubmit}>
            {saveLabel}
          </Button>
        </form>
      </div>
    </Card>
  {:else}
    <p class="fs-empty">{emptyMessage}</p>
  {/each}
</section>

<style>
  .feature-settings {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .fs-flash {
    margin: 0;
    padding: 0.625rem 0.75rem;
    border-radius: 0.375rem;
    background: var(--color-surface-muted, #f3f4f6);
  }

  .fs-flash-error {
    color: var(--color-error-text, #991b1b);
    background: var(--color-error-surface, #fef2f2);
  }

  .fs-empty {
    margin: 0;
    color: var(--color-text-muted, #6b7280);
    font-style: italic;
  }

  .fs-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(16rem, 22rem);
    gap: 1rem;
    align-items: start;
  }

  .fs-copy {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .fs-title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .fs-title {
    margin: 0;
    font-size: 1rem;
    line-height: 1.25;
  }

  .fs-description {
    margin: 0;
    color: var(--color-text-muted, #6b7280);
    line-height: 1.45;
  }

  .fs-key,
  .fs-package {
    font-size: 0.8125rem;
    color: var(--color-text-muted, #6b7280);
    overflow-wrap: anywhere;
  }

  .fs-controls {
    display: flex;
    align-items: flex-end;
    gap: 0.5rem;
  }

  .fs-field {
    min-width: 0;
    flex: 1 1 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .fs-field-label {
    font-size: 0.8125rem;
    color: var(--color-text-muted, #6b7280);
  }

  .fs-field select {
    width: 100%;
    padding: 0.375rem 0.5rem;
    border: 1px solid var(--color-border, #d1d5db);
    border-radius: 0.375rem;
    background: var(--color-surface, #fff);
    color: inherit;
    font: inherit;
  }

  .fs-readonly {
    margin: 0;
    line-height: 1.45;
  }

  @media (max-width: 860px) {
    .fs-row {
      grid-template-columns: 1fr;
    }

    .fs-controls {
      flex-direction: column;
      align-items: stretch;
    }
  }
</style>
