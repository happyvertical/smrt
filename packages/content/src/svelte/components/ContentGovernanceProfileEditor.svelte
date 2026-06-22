<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import type {
  ContentGovernanceProfileData,
  ContentReviewPolicyData,
} from '../../mock-smrt-client';
import { M } from '../i18n.tools.js';

const { t } = useI18n();

export interface Props {
  profile?: Partial<ContentGovernanceProfileData>;
  policies?: ContentReviewPolicyData[];
  onSave: (profile: Partial<ContentGovernanceProfileData>) => void;
  onCancel?: () => void;
}

let {
  profile = {},
  policies = [],
  onSave,
  onCancel = undefined,
}: Props = $props();

function createDefaultRequirement(
  availablePolicies: ContentReviewPolicyData[],
) {
  return {
    policyKey: availablePolicies[0]?.key || 'safety',
    label: availablePolicies[0]?.label || 'Safety Review',
    blocking: false,
    acceptedStatuses: ['passed', 'waived'],
  };
}

function createDraft(
  sourceProfile: Partial<ContentGovernanceProfileData>,
  availablePolicies: ContentReviewPolicyData[],
) {
  return {
    key: sourceProfile.key || '',
    label: sourceProfile.label || '',
    description: sourceProfile.description || '',
    enabled: sourceProfile.enabled ?? true,
    requirements:
      Array.isArray(sourceProfile.requirements) &&
      sourceProfile.requirements.length > 0
        ? sourceProfile.requirements.map((requirement) => ({ ...requirement }))
        : [createDefaultRequirement(availablePolicies)],
  };
}

let draft = $state(createDraft({}, []));

$effect(() => {
  draft = createDraft(profile, policies);
});

function addRequirement() {
  draft.requirements = [
    ...draft.requirements,
    createDefaultRequirement(policies),
  ];
}

function removeRequirement(index: number) {
  draft.requirements = draft.requirements.filter(
    (_, requirementIndex) => requirementIndex !== index,
  );
}

function handleSubmit() {
  onSave({
    ...profile,
    key: draft.key,
    label: draft.label,
    description: draft.description,
    enabled: draft.enabled,
    requirements: draft.requirements,
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
    Description
    <textarea rows="2" bind:value={draft.description}></textarea>
  </label>
  <label class="checkbox">
    <input type="checkbox" bind:checked={draft.enabled} />
    Enabled
  </label>

  <div class="requirements">
    <div class="requirements__header">
      <strong>Requirements</strong>
      <button type="button" class="secondary" onclick={addRequirement}>
        {t(M['content.governance_profile_editor.add_requirement'])}
      </button>
    </div>

    {#each draft.requirements as requirement, index (`${requirement.policyKey}-${index}`)}
      <div class="requirement-row">
        <label>
          Policy
          <select bind:value={requirement.policyKey}>
            {#each policies as policy (policy.key)}
              <option value={policy.key}>{policy.label}</option>
            {/each}
          </select>
        </label>
        <label>
          Label
          <input type="text" bind:value={requirement.label} />
        </label>
        <label class="checkbox">
          <input type="checkbox" bind:checked={requirement.blocking} />
          Blocking
        </label>
        <button type="button" class="secondary" onclick={() => removeRequirement(index)}>
          Remove
        </button>
      </div>
    {/each}
  </div>

  <div class="actions">
    <button type="submit">{t(M['content.governance_profile_editor.save_profile'])}</button>
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

  .requirements {
    display: grid;
    gap: 0.75rem;
  }

  .requirements__header,
  .requirement-row,
  .actions {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    flex-wrap: wrap;
  }
</style>
