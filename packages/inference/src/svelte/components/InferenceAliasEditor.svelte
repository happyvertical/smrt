<script lang="ts">
/**
 * One alias: its ordered candidates, a per-candidate test, and (when
 * editable) reorder, remove, add and save. Candidates name `apiKeyEnv`
 * (a variable) when they need their own key; the editor never takes a key.
 */
import { untrack } from 'svelte';
import type {
  InferenceAliasChange,
  InferenceAliasView,
  InferenceCandidateView,
  InferenceTestResultView,
} from '../types.js';
import { candidateViewLabel } from '../types.js';

interface InferenceAliasEditorProps {
  alias: InferenceAliasView;
  editable: boolean;
  busy: boolean;
  isNew?: boolean;
  onSaveAlias?: (change: InferenceAliasChange) => void;
  onTestCandidate?: (
    candidate: InferenceCandidateView,
  ) => Promise<InferenceTestResultView>;
}

const {
  alias,
  editable,
  busy,
  isNew = false,
  onSaveAlias,
  onTestCandidate,
}: InferenceAliasEditorProps = $props();

let name = $state(untrack(() => alias.name));
let candidates = $state<InferenceCandidateView[]>(
  untrack(() => alias.candidates.map((candidate) => ({ ...candidate }))),
);
let results = $state<Record<number, InferenceTestResultView | 'pending'>>({});
let draft = $state<InferenceCandidateView>({});

function move(index: number, by: number): void {
  const next = index + by;
  if (next < 0 || next >= candidates.length) return;
  const copy = [...candidates];
  [copy[index], copy[next]] = [
    copy[next] as InferenceCandidateView,
    copy[index] as InferenceCandidateView,
  ];
  candidates = copy;
  results = {};
}

function remove(index: number): void {
  candidates = candidates.filter((_, at) => at !== index);
  results = {};
}

function add(): void {
  const candidate: InferenceCandidateView = {};
  for (const member of [
    'provider',
    'preset',
    'alias',
    'model',
    'baseUrl',
    'apiKeyEnv',
  ] as const) {
    const value = draft[member]?.trim();
    if (value) candidate[member] = value;
  }
  if (Object.keys(candidate).length === 0) return;
  candidates = [...candidates, candidate];
  draft = {};
}

async function test(index: number): Promise<void> {
  const candidate = candidates[index];
  if (!onTestCandidate || !candidate) return;
  results = { ...results, [index]: 'pending' };
  try {
    const result = await onTestCandidate(
      $state.snapshot(candidate) as InferenceCandidateView,
    );
    results = { ...results, [index]: result };
  } catch {
    results = {
      ...results,
      [index]: { reachable: false, detail: 'The test could not run.' },
    };
  }
}

function save(event: SubmitEvent): void {
  event.preventDefault();
  if (!onSaveAlias || !name.trim()) return;
  const change: InferenceAliasChange = {
    name: name.trim(),
    candidates: $state.snapshot(candidates) as InferenceCandidateView[],
  };
  if (alias.description) change.description = alias.description;
  onSaveAlias(change);
}
</script>

<form class="iae" onsubmit={save} data-testid={`inference-alias-${isNew ? 'new' : alias.name}`}>
  <div class="iae-head">
    {#if isNew}
      <label>
        <span class="iae-label">New alias name</span>
        <input name="aliasName" bind:value={name} required disabled={busy} />
      </label>
    {:else}
      <strong>{alias.name}</strong>
      <span class="iae-label">{alias.source === 'app' ? 'App' : 'Config'}</span>
      {#if alias.description}<span class="iae-label">{alias.description}</span>{/if}
    {/if}
  </div>
  <ol class="iae-list">
    {#each candidates as candidate, index (index)}
      {@const result = results[index]}
      <li class="iae-candidate">
        <code>{candidateViewLabel(candidate)}</code>
        {#if candidate.apiKeyEnv}<span class="iae-label">key from {candidate.apiKeyEnv}</span>{/if}
        {#if onTestCandidate && !candidate.alias}
          <button type="button" onclick={() => test(index)} disabled={busy || result === 'pending'}>
            Test
          </button>
        {/if}
        {#if editable}
          <button type="button" aria-label={`Move ${candidateViewLabel(candidate)} up`} onclick={() => move(index, -1)} disabled={busy || index === 0}>↑</button>
          <button type="button" aria-label={`Move ${candidateViewLabel(candidate)} down`} onclick={() => move(index, 1)} disabled={busy || index === candidates.length - 1}>↓</button>
          <button type="button" aria-label={`Remove ${candidateViewLabel(candidate)}`} onclick={() => remove(index)} disabled={busy}>Remove</button>
        {/if}
        {#if result && result !== 'pending'}
          <span class="iae-label" role="status">
            {result.reachable ? 'Reachable' : result.skipped ? 'Not tested' : 'Failed'}: {result.detail}
          </span>
        {/if}
      </li>
    {:else}
      <li class="iae-label">No candidates yet.</li>
    {/each}
  </ol>
  {#if editable}
    <fieldset class="iae-add" disabled={busy}>
      <legend class="iae-label">Add candidate</legend>
      <input aria-label="Provider" placeholder="provider" bind:value={draft.provider} />
      <input aria-label="Preset" placeholder="preset" bind:value={draft.preset} />
      <input aria-label="Nested alias" placeholder="alias" bind:value={draft.alias} />
      <input aria-label="Model" placeholder="model" bind:value={draft.model} />
      <input aria-label="Base URL" placeholder="base URL" bind:value={draft.baseUrl} />
      <input aria-label="Key variable" placeholder="key variable (e.g. OPENROUTER_API_KEY)" bind:value={draft.apiKeyEnv} />
      <button type="button" onclick={add}>Add</button>
    </fieldset>
    <div class="iae-actions">
      <button type="submit" disabled={busy || !onSaveAlias || candidates.length === 0}>Save alias</button>
      {#if !isNew && alias.source === 'app'}
        <button
          type="button"
          disabled={busy || !onSaveAlias}
          onclick={() => onSaveAlias?.({ name: alias.name, candidates: null })}
        >
          {alias.inConfig ? 'Revert to config' : 'Remove alias'}
        </button>
      {/if}
    </div>
  {/if}
</form>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .iae {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.5rem 0;
    border-bottom: var(--smrt-hairline);
  }
  .iae-head,
  .iae-candidate,
  .iae-actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-wrap: wrap;
  }
  .iae-list {
    margin: 0;
    padding-left: 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .iae-add {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    border: none;
    padding: 0;
    margin: 0;
  }
  .iae-label {
    font-size: 0.8125rem;
    color: var(--smrt-color-on-surface-variant);
  }
}
</style>
