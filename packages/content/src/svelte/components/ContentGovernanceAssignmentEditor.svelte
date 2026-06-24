<script lang="ts">
import { Form, Input, Select } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import type {
  ContentGovernanceAssignmentData,
  ContentGovernanceProfileData,
} from '../../mock-smrt-client';
import { M } from '../i18n.tools.js';

const { t } = useI18n();

export interface Props {
  assignment?: Partial<ContentGovernanceAssignmentData>;
  profiles?: ContentGovernanceProfileData[];
  onSave: (assignment: Partial<ContentGovernanceAssignmentData>) => void;
  onCancel?: () => void;
}

let {
  assignment = {},
  profiles = [],
  onSave,
  onCancel = undefined,
}: Props = $props();

function resolveProfileKey(
  preferredKey: string | null | undefined,
  availableProfiles: ContentGovernanceProfileData[],
  fallbackKey?: string,
) {
  if (
    preferredKey &&
    availableProfiles.some((profile) => profile.key === preferredKey)
  ) {
    return preferredKey;
  }

  if (
    fallbackKey &&
    availableProfiles.some((profile) => profile.key === fallbackKey)
  ) {
    return fallbackKey;
  }

  return availableProfiles[0]?.key || '';
}

function createDraft(
  sourceAssignment: Partial<ContentGovernanceAssignmentData>,
  availableProfiles: ContentGovernanceProfileData[],
) {
  return {
    label: sourceAssignment.label || '',
    contentType: sourceAssignment.contentType || 'article',
    contentVariant: sourceAssignment.contentVariant || '',
    enabled: sourceAssignment.enabled ?? true,
    factLinkingEnabled: sourceAssignment.factLinkingEnabled ?? true,
    transparencyEnabled: sourceAssignment.transparencyEnabled ?? true,
    publicationProfileKey: resolveProfileKey(
      sourceAssignment.publicationProfileKey,
      availableProfiles,
      'publication',
    ),
    correctionProfileKey: resolveProfileKey(
      sourceAssignment.correctionProfileKey,
      availableProfiles,
      'correction',
    ),
    enforcePublishReadiness: sourceAssignment.enforcePublishReadiness ?? false,
    defaultFactRelationship:
      sourceAssignment.defaultFactRelationship || 'supports',
  };
}

let draft = $state(createDraft({}, []));

$effect(() => {
  draft = createDraft(assignment, profiles);
});

function handleSubmit() {
  onSave({
    ...assignment,
    label: draft.label,
    contentType: draft.contentType,
    contentVariant: draft.contentVariant || null,
    enabled: draft.enabled,
    factLinkingEnabled: draft.factLinkingEnabled,
    transparencyEnabled: draft.transparencyEnabled,
    publicationProfileKey: draft.publicationProfileKey || null,
    correctionProfileKey: draft.correctionProfileKey || null,
    enforcePublishReadiness: draft.enforcePublishReadiness,
    defaultFactRelationship: draft.defaultFactRelationship,
  });
}
</script>

<div class="governance-editor-shell">
  <Form class="governance-editor" onsubmit={(event) => {
    event.preventDefault();
    handleSubmit();
  }}>
    <label>
      Label
      <Input type="text" bind:value={draft.label} />
    </label>
    <label>
      {t(M['content.governance_assignment_editor.content_type'])}
      <Input type="text" bind:value={draft.contentType} required />
    </label>
    <label>
      {t(M['content.governance_assignment_editor.content_variant'])}
      <Input type="text" bind:value={draft.contentVariant} />
    </label>
    <label>
      {t(M['content.governance_assignment_editor.publication_profile'])}
      <Select bind:value={draft.publicationProfileKey}>
        <option value="" disabled={profiles.length > 0}>{t(M['content.governance_assignment_editor.select_a_profile'])}</option>
        {#each profiles as profile (profile.key)}
          <option value={profile.key}>{profile.label}</option>
        {/each}
      </Select>
    </label>
    <label>
      {t(M['content.governance_assignment_editor.correction_profile'])}
      <Select bind:value={draft.correctionProfileKey}>
        <option value="" disabled={profiles.length > 0}>{t(M['content.governance_assignment_editor.select_a_profile'])}</option>
        {#each profiles as profile (profile.key)}
          <option value={profile.key}>{profile.label}</option>
        {/each}
      </Select>
    </label>
    <label>
      {t(M['content.governance_assignment_editor.default_fact_relationship'])}
      <Select bind:value={draft.defaultFactRelationship}>
        <option value="supports">supports</option>
        <option value="referenced_in">referenced_in</option>
        <option value="contradicts">contradicts</option>
        <option value="related">related</option>
      </Select>
    </label>

    <div class="checkbox-grid">
      <label class="checkbox">
        <!-- raw-primitive-allow: native checkbox; no Provider-free checkbox primitive (Toggle is a switch with different semantics, CheckboxInput requires a Provider) -->
        <input type="checkbox" bind:checked={draft.enabled} />
        Enabled
      </label>
      <label class="checkbox">
        <!-- raw-primitive-allow: native checkbox; no Provider-free checkbox primitive (Toggle is a switch with different semantics, CheckboxInput requires a Provider) -->
        <input type="checkbox" bind:checked={draft.factLinkingEnabled} />
        {t(M['content.governance_assignment_editor.fact_linking'])}
      </label>
      <label class="checkbox">
        <!-- raw-primitive-allow: native checkbox; no Provider-free checkbox primitive (Toggle is a switch with different semantics, CheckboxInput requires a Provider) -->
        <input type="checkbox" bind:checked={draft.transparencyEnabled} />
        Transparency
      </label>
      <label class="checkbox">
        <!-- raw-primitive-allow: native checkbox; no Provider-free checkbox primitive (Toggle is a switch with different semantics, CheckboxInput requires a Provider) -->
        <input type="checkbox" bind:checked={draft.enforcePublishReadiness} />
        {t(M['content.governance_assignment_editor.enforce_publish_readiness'])}
      </label>
    </div>

    <div class="actions">
      <Button variant="primary" type="submit">{t(M['content.governance_assignment_editor.save_assignment'])}</Button>
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

  .checkbox-grid,
  .actions {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .checkbox {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
</style>
