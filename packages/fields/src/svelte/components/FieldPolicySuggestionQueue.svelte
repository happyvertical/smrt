<script lang="ts">
/** Accessible, host-transport-neutral review queue for pending suggestions. */
import { Button } from '@happyvertical/smrt-ui/ui';
import {
  type FieldPolicySuggestion,
  type FieldPolicySuggestionAdapter,
  fieldPolicySuggestionEvidence,
  parsePendingFieldPolicySuggestions,
} from '../suggestions.js';

export interface FieldPolicySuggestionQueueProps {
  /** Transport for loading and reviewing suggestions. */
  adapter: FieldPolicySuggestionAdapter;
  /** Optional list of object identifiers to filter suggestions. */
  objectRefs?: readonly string[];
  /** Section heading for the suggestion queue. */
  heading?: string;
  /** Callback invoked after a suggestion is approved or dismissed. */
  onchanged?: () => void;
}

let {
  adapter,
  objectRefs,
  heading = 'Pending field suggestions',
  onchanged,
}: FieldPolicySuggestionQueueProps = $props();

let suggestions = $state<FieldPolicySuggestion[]>([]);
let total = $state(0);
let loading = $state(false);
let busyId = $state<string | null>(null);
let error = $state<string | null>(null);
let generation = 0;

async function load(): Promise<void> {
  const token = ++generation;
  loading = true;
  error = null;
  try {
    const result = parsePendingFieldPolicySuggestions(
      await adapter.pendingSuggestions(
        objectRefs?.length ? { objectRefs } : undefined,
      ),
    );
    if (token !== generation) return;
    suggestions = result.suggestions;
    total = result.total;
  } catch (cause) {
    if (token !== generation) return;
    suggestions = [];
    total = 0;
    error =
      cause instanceof Error
        ? cause.message
        : 'Unable to load pending field suggestions.';
  } finally {
    if (token === generation) loading = false;
  }
}

async function decide(
  suggestion: FieldPolicySuggestion,
  decision: 'approve' | 'dismiss',
): Promise<void> {
  if (busyId) return;
  busyId = suggestion.id;
  error = null;
  try {
    if (decision === 'approve') {
      await adapter.acceptSuggestion({ id: suggestion.id });
    } else {
      await adapter.dismissSuggestion({ id: suggestion.id });
    }
    await load();
    onchanged?.();
  } catch (cause) {
    error =
      cause instanceof Error
        ? cause.message
        : 'Unable to update this field suggestion.';
  } finally {
    busyId = null;
  }
}

$effect(() => {
  adapter;
  objectRefs;
  void load();
});

function description(suggestion: FieldPolicySuggestion): string {
  return suggestion.kind === 'promote'
    ? `Promote ${suggestion.fieldName} to the basic form.`
    : `Set an organization default for ${suggestion.fieldName}.`;
}
</script>

<section class="smrt-field-policy-suggestion-queue__root" aria-label={heading} data-smrt-component="FieldPolicySuggestionQueue">
  <header data-smrt-part="header">
    <h2>{heading}</h2>
    {#if !loading}<span class="smrt-field-policy-suggestion-queue__count" data-smrt-part="count">{total}</span>{/if}
  </header>
  {#if loading}
    <p role="status" aria-live="polite">Loading pending suggestions…</p>
  {:else if error}
    <p role="alert">{error}</p>
  {:else if suggestions.length === 0}
    <p>No pending field suggestions.</p>
  {:else}
    <ul data-smrt-part="list">
      {#each suggestions as suggestion (suggestion.id)}
        <li data-smrt-part="row">
          <article>
            <h3>{suggestion.objectRef} · {suggestion.fieldName}</h3>
            <p>{description(suggestion)}</p>
            <p>{fieldPolicySuggestionEvidence(suggestion)}</p>
            <div class="smrt-field-policy-suggestion-queue__actions" data-smrt-part="actions">
              <Button type="button" disabled={busyId !== null} onclick={() => decide(suggestion, 'approve')}>Approve</Button>
              <Button type="button" variant="ghost" disabled={busyId !== null} onclick={() => decide(suggestion, 'dismiss')}>Dismiss</Button>
            </div>
          </article>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-field-policy-suggestion-queue__root {
    display: grid;
    gap: var(--smrt-spacing-3, 0.75rem);
  }
  .smrt-field-policy-suggestion-queue__root header {
    align-items: center;
    display: flex;
    gap: var(--smrt-spacing-2, 0.5rem);
  }
  .smrt-field-policy-suggestion-queue__root h2, .smrt-field-policy-suggestion-queue__root h3 {
    margin: 0;
  }
  .smrt-field-policy-suggestion-queue__count {
    min-inline-size: 1.5rem;
    padding: 0.125rem 0.4rem;
  }
  .smrt-field-policy-suggestion-queue__root ul {
    display: grid;
    gap: var(--smrt-spacing-3, 0.75rem);
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .smrt-field-policy-suggestion-queue__root article {
    display: grid;
    gap: var(--smrt-spacing-2, 0.5rem);
    padding: var(--smrt-spacing-3, 0.75rem);
  }
  .smrt-field-policy-suggestion-queue__root article p {
    margin: 0;
  }
  .smrt-field-policy-suggestion-queue__actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-2, 0.5rem);
  }
}

@layer smrt.theme {
  .smrt-field-policy-suggestion-queue__count {
    border-radius: 999px;
    background: var(--smrt-color-secondary-container);
    text-align: center;
  }
  .smrt-field-policy-suggestion-queue__root article {
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-small, 0.25rem);
  }
}

</style>
