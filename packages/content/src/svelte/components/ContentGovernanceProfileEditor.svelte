<script lang="ts">
import { Form, Input, Select, Textarea } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import type {
  ContentGovernanceProfileData,
  ContentReviewPolicyData,
} from '../../mock-smrt-client';
import { M } from '../i18n.tools.js';

const { t } = useI18n();

export interface Props {
  /** The governance profile to edit, or an empty object for new. */
  profile?: Partial<ContentGovernanceProfileData>;
  /** Available review policies to include in profile requirements. */
  policies?: ContentReviewPolicyData[];
  /** Fired when the user saves the profile configuration. */
  onSave: (profile: Partial<ContentGovernanceProfileData>) => void;
  /** Fired when the user cancels editing. */
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

<div class="smrt-content-governance-profile-editor__root" data-smrt-component="ContentGovernanceProfileEditor">
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
      Description
      <Textarea rows={2} bind:value={draft.description}></Textarea>
    </label>
    <label class="smrt-content-governance-profile-editor__checkbox" data-smrt-part="field">
      <!-- raw-primitive-allow: native checkbox; no Provider-free checkbox primitive (Toggle is a switch with different semantics, CheckboxInput requires a Provider) -->
      <input type="checkbox" bind:checked={draft.enabled} />
      Enabled
    </label>

    <div class="smrt-content-governance-profile-editor__requirements" data-smrt-part="list">
      <div class="smrt-content-governance-profile-editor__requirements-header" data-smrt-part="header">
        <strong>Requirements</strong>
        <Button variant="secondary" type="button" onclick={addRequirement}>
          {t(M['content.governance_profile_editor.add_requirement'])}
        </Button>
      </div>

      {#each draft.requirements as requirement, index (`${requirement.policyKey}-${index}`)}
        <div class="smrt-content-governance-profile-editor__requirement-row" data-smrt-part="row">
          <label>
            Policy
            <Select bind:value={requirement.policyKey}>
              {#each policies as policy (policy.key)}
                <option value={policy.key}>{policy.label}</option>
              {/each}
            </Select>
          </label>
          <label>
            Label
            <Input type="text" bind:value={requirement.label} />
          </label>
          <label class="smrt-content-governance-profile-editor__checkbox" data-smrt-part="field">
            <!-- raw-primitive-allow: native checkbox; no Provider-free checkbox primitive (Toggle is a switch with different semantics, CheckboxInput requires a Provider) -->
            <input type="checkbox" bind:checked={requirement.blocking} />
            Blocking
          </label>
          <Button variant="danger" type="button" onclick={() => removeRequirement(index)}>
            Remove
          </Button>
        </div>
      {/each}
    </div>

    <div class="smrt-content-governance-profile-editor__actions" data-smrt-part="actions">
      <Button variant="primary" type="submit">{t(M['content.governance_profile_editor.save_profile'])}</Button>
      {#if onCancel}
        <Button variant="secondary" type="button" onclick={() => onCancel?.()}>
          Cancel
        </Button>
      {/if}
    </div>
  </Form>
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-content-governance-profile-editor__root :global(.governance-editor) {
    display: grid;
    gap: 0.75rem;
  }
  label {
    display: grid;
    gap: 0.35rem;
  }
  .smrt-content-governance-profile-editor__checkbox {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .smrt-content-governance-profile-editor__requirements {
    display: grid;
    gap: 0.75rem;
  }
  .smrt-content-governance-profile-editor__requirements-header,
  .smrt-content-governance-profile-editor__requirement-row,
  .smrt-content-governance-profile-editor__actions {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    flex-wrap: wrap;
  }
}

@layer smrt.theme {
  label {
    font-size: var(--smrt-typography-label-large-size, 0.9rem);
  }
}

</style>
