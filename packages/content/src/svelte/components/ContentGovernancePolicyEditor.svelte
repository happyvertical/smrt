<script lang="ts">
import type { ContentReviewPolicyData } from '../../mock-smrt-client';

export interface Props {
  policy?: Partial<ContentReviewPolicyData>;
  onSave: (policy: Partial<ContentReviewPolicyData>) => void;
  onCancel?: () => void;
}

let { policy = {}, onSave, onCancel = undefined }: Props = $props();

function createDraft(sourcePolicy: Partial<ContentReviewPolicyData>) {
  return {
    key: sourcePolicy.key || '',
    label: sourcePolicy.label || '',
    kind: sourcePolicy.kind || 'custom',
    instructions: sourcePolicy.instructions || '',
    enabled: sourcePolicy.enabled ?? true,
  };
}

let draft = $state(createDraft({}));

$effect(() => {
  draft = createDraft(policy);
});

function handleSubmit() {
  onSave({
    ...policy,
    key: draft.key,
    label: draft.label,
    kind: draft.kind,
    instructions: draft.instructions,
    enabled: draft.enabled,
  });
}
</script>

<form class="governance-editor" onsubmit={(event) => {
  event.preventDefault();
  handleSubmit();
}}>
  <label>
    Key
    <input type="text" bind:value={draft.key} required />
  </label>
  <label>
    Label
    <input type="text" bind:value={draft.label} />
  </label>
  <label>
    Kind
    <select bind:value={draft.kind}>
      <option value="facts">Facts</option>
      <option value="safety">Safety</option>
      <option value="custom">Custom</option>
    </select>
  </label>
  <label>
    Instructions
    <textarea rows="4" bind:value={draft.instructions}></textarea>
  </label>
  <label class="checkbox">
    <input type="checkbox" bind:checked={draft.enabled} />
    Enabled
  </label>
  <div class="actions">
    <button type="submit">Save policy</button>
    {#if onCancel}
      <button type="button" class="secondary" onclick={() => onCancel?.()}>
        Cancel
      </button>
    {/if}
  </div>
</form>

<style>
  .governance-editor {
    display: grid;
    gap: 0.75rem;
  }

  label {
    display: grid;
    gap: 0.35rem;
    font-size: var(--smrt-typography-label-large-size, 0.9rem);
  }

  input,
  select,
  textarea {
    width: 100%;
  }

  .checkbox {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .actions {
    display: flex;
    gap: 0.75rem;
  }
</style>
