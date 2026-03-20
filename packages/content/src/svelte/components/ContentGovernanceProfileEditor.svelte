<script lang="ts">
import type {
  ContentGovernanceProfileData,
  ContentReviewPolicyData,
} from '../../mock-smrt-client';

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
} = $props<Props>();

let key = $state(profile.key || '');
let label = $state(profile.label || '');
let description = $state(profile.description || '');
let enabled = $state(profile.enabled ?? true);
let requirements = $state(
  Array.isArray(profile.requirements) && profile.requirements.length > 0
    ? profile.requirements.map((requirement) => ({ ...requirement }))
    : [
        {
          policyKey: policies[0]?.key || 'safety',
          label: policies[0]?.label || 'Safety Review',
          blocking: false,
          acceptedStatuses: ['passed', 'waived'],
        },
      ],
);

function addRequirement() {
  requirements = [
    ...requirements,
    {
      policyKey: policies[0]?.key || 'safety',
      label: policies[0]?.label || 'Safety Review',
      blocking: false,
      acceptedStatuses: ['passed', 'waived'],
    },
  ];
}

function removeRequirement(index: number) {
  requirements = requirements.filter(
    (_, requirementIndex) => requirementIndex !== index,
  );
}

function handleSubmit() {
  onSave({
    ...profile,
    key,
    label,
    description,
    enabled,
    requirements,
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
    Description
    <textarea rows="2" bind:value={description}></textarea>
  </label>
  <label class="checkbox">
    <input type="checkbox" bind:checked={enabled} />
    Enabled
  </label>

  <div class="requirements">
    <div class="requirements__header">
      <strong>Requirements</strong>
      <button type="button" class="secondary" onclick={addRequirement}>
        Add requirement
      </button>
    </div>

    {#each requirements as requirement, index (`${requirement.policyKey}-${index}`)}
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
    <button type="submit">Save profile</button>
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
