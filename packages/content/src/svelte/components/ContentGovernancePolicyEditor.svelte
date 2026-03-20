<script lang="ts">
import type { ContentReviewPolicyData } from '../../mock-smrt-client';

export interface Props {
  policy?: Partial<ContentReviewPolicyData>;
  onSave: (policy: Partial<ContentReviewPolicyData>) => void;
  onCancel?: () => void;
}

let { policy = {}, onSave, onCancel = undefined } = $props<Props>();

let key = $state(policy.key || '');
let label = $state(policy.label || '');
let kind = $state(policy.kind || 'custom');
let instructions = $state(policy.instructions || '');
let enabled = $state(policy.enabled ?? true);

function handleSubmit() {
  onSave({
    ...policy,
    key,
    label,
    kind,
    instructions,
    enabled,
  });
}
</script>

<form class="governance-editor" onsubmit={(event) => {
  event.preventDefault();
  handleSubmit();
}}>
  <label>
    Key
    <input type="text" bind:value={key} required />
  </label>
  <label>
    Label
    <input type="text" bind:value={label} />
  </label>
  <label>
    Kind
    <select bind:value={kind}>
      <option value="facts">Facts</option>
      <option value="safety">Safety</option>
      <option value="custom">Custom</option>
    </select>
  </label>
  <label>
    Instructions
    <textarea rows="4" bind:value={instructions}></textarea>
  </label>
  <label class="checkbox">
    <input type="checkbox" bind:checked={enabled} />
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
    font-size: 0.9rem;
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
