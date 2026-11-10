<script lang="ts">
/**
 * One rung of the tier ladder: "same as default", a model, an alias or a
 * fusion. In the tenant scope, targets the allow-list does not open are
 * disabled (display only; the server enforces the list on every write).
 */
import { untrack } from 'svelte';
import type {
  InferenceAliasView,
  InferenceFusionView,
  InferenceProviderView,
  InferenceSettingsScope,
  InferenceTargetView,
  InferenceTierChange,
  InferenceTierView,
} from '../types.js';
import {
  inferenceLevelLabel,
  isRefAllowed,
  targetViewRef,
  tierRevertPreview,
} from '../types.js';

interface InferenceTierRowProps {
  row: InferenceTierView;
  scope: InferenceSettingsScope;
  providers: InferenceProviderView[];
  aliases: InferenceAliasView[];
  fusions: InferenceFusionView[];
  busy: boolean;
  onSaveTier?: (change: InferenceTierChange) => void;
}

const {
  row,
  scope,
  providers,
  aliases,
  fusions,
  busy,
  onSaveTier,
}: InferenceTierRowProps = $props();

type Kind = 'default' | 'model' | 'alias' | 'fusion';

function kindOf(target: InferenceTargetView | null | undefined): Kind {
  if (!target || Object.keys(target).length === 0) return 'default';
  if (target.kind === 'fusion' || target.fusion) return 'fusion';
  if (target.alias) return 'alias';
  return 'model';
}

const own = untrack(
  () => (scope === 'app' ? row.appTarget : row.tenantTarget) ?? null,
);
let kind = $state<Kind>(kindOf(own));
let provider = $state(own?.provider ?? '');
let model = $state(own?.model ?? '');
let alias = $state(own?.alias ?? '');
let fusion = $state(own?.fusion ?? '');

const restricted = $derived(scope === 'tenant');
const allowed = (target: InferenceTargetView) =>
  !restricted || isRefAllowed(targetViewRef(target), row.tenantAllowList);
const modelAllowed = $derived(
  !restricted ||
    (row.tenantAllowList ?? []).some(
      (pattern) => pattern === '*' || pattern.startsWith('model:'),
    ),
);
const aliasAllowed = $derived(
  aliases.some((entry) => allowed({ alias: entry.name })),
);
const fusionAllowed = $derived(
  fusions.some((entry) => allowed({ kind: 'fusion', fusion: entry.name })),
);

function target(): InferenceTargetView | null {
  if (kind === 'model') {
    return provider
      ? { provider, model: model.trim() }
      : { model: model.trim() };
  }
  if (kind === 'alias') return { alias };
  if (kind === 'fusion') return { kind: 'fusion', fusion };
  return null;
}

function submit(event: SubmitEvent): void {
  event.preventDefault();
  onSaveTier?.({ tier: row.tier, scope, target: target() });
}
</script>

<form class="itr" onsubmit={submit} data-testid={`inference-tier-${row.tier}`}>
  <div class="itr-head">
    <strong class="itr-tier">{row.tier}</strong>
    <span class="itr-effective">{row.effectiveLabel}</span>
    <span class="itr-level">{inferenceLevelLabel(row.supplyingLevel)}</span>
  </div>
  {#if restricted && row.tenantBlocked}
    <p class="itr-note" role="note">
      This tenant binding is no longer on the allow-list and is not in effect.
    </p>
  {/if}
  <div class="itr-controls">
    <label>
      <span class="itr-label">Target for {row.tier}</span>
      <select name="kind" bind:value={kind} disabled={busy}>
        <option value="default">Same as default</option>
        <option value="model" disabled={!modelAllowed}>Model</option>
        <option value="alias" disabled={!aliasAllowed}>Alias</option>
        <option value="fusion" disabled={!fusionAllowed}>Fusion</option>
      </select>
    </label>
    {#if kind === 'model'}
      <label>
        <span class="itr-label">Provider</span>
        <select name="provider" bind:value={provider} disabled={busy}>
          <option value="">Configured provider</option>
          {#each providers.filter((option) => option.kind === 'provider') as option (option.id)}
            <option value={option.id}>{option.label}</option>
          {/each}
        </select>
      </label>
      <label>
        <span class="itr-label">Model</span>
        <input name="model" bind:value={model} required disabled={busy} />
      </label>
    {:else if kind === 'alias'}
      <label>
        <span class="itr-label">Alias</span>
        <select name="alias" bind:value={alias} required disabled={busy}>
          <option value="" disabled>Choose an alias</option>
          {#each aliases as entry (entry.name)}
            <option value={entry.name} disabled={!allowed({ alias: entry.name })}>{entry.name}</option>
          {/each}
        </select>
      </label>
    {:else if kind === 'fusion'}
      <label>
        <span class="itr-label">Fusion</span>
        <select name="fusion" bind:value={fusion} required disabled={busy}>
          <option value="" disabled>Choose a fusion</option>
          {#each fusions as entry (entry.name)}
            <option value={entry.name} disabled={!allowed({ kind: 'fusion', fusion: entry.name })}>
              {entry.name}
            </option>
          {/each}
        </select>
      </label>
    {/if}
    <button type="submit" disabled={busy || !onSaveTier}>Save</button>
  </div>
  <p class="itr-hint">"Same as default" reverts to: {tierRevertPreview(row, scope)}</p>
</form>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .itr {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.5rem 0;
    border-bottom: var(--smrt-hairline);
  }
  .itr-head {
    display: flex;
    gap: 0.75rem;
    align-items: baseline;
    flex-wrap: wrap;
  }
  .itr-tier {
    text-transform: capitalize;
    min-width: 4rem;
  }
  .itr-level,
  .itr-hint,
  .itr-note,
  .itr-label {
    font-size: 0.8125rem;
    color: var(--smrt-color-on-surface-variant);
  }
  .itr-hint,
  .itr-note {
    margin: 0;
  }
  .itr-label {
    display: block;
  }
  .itr-controls {
    display: flex;
    gap: 0.5rem;
    align-items: flex-end;
    flex-wrap: wrap;
  }
}
</style>
