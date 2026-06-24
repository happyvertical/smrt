<script lang="ts">
import { Form, Input, Select, Textarea } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { ContentReviewPolicyData } from '../../mock-smrt-client';
import { M } from '../i18n.tools.js';

const { t } = useI18n();

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

<div class="governance-editor-shell">
  <Form class="governance-editor" onsubmit={(event) => {
    event.preventDefault();
    handleSubmit();
  }}>
    <label>
      Key
      <Input type="text" bind:value={draft.key} required />
    </label>
    <label>
      Label
      <Input type="text" bind:value={draft.label} />
    </label>
    <label>
      Kind
      <Select bind:value={draft.kind}>
        <option value="facts">Facts</option>
        <option value="safety">Safety</option>
        <option value="custom">Custom</option>
      </Select>
    </label>
    <label>
      Instructions
      <Textarea rows={4} bind:value={draft.instructions}></Textarea>
    </label>
    <label class="checkbox">
      <!-- raw-primitive-allow: native checkbox; no Provider-free checkbox primitive (Toggle is a switch with different semantics, CheckboxInput requires a Provider) -->
      <input type="checkbox" bind:checked={draft.enabled} />
      Enabled
    </label>
    <div class="actions">
      <Button variant="primary" type="submit">{t(M['content.governance_policy_editor.save_policy'])}</Button>
      {#if onCancel}
        <Button variant="secondary" type="button" onclick={() => onCancel?.()}>
          Cancel
        </Button>
      {/if}
    </div>
  </Form>
</div>

<style>
  .governance-editor-shell :global(.governance-editor) {
    display: grid;
    gap: 0.75rem;
  }

  label {
    display: grid;
    gap: 0.35rem;
    font-size: var(--smrt-typography-label-large-size, 0.9rem);
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
