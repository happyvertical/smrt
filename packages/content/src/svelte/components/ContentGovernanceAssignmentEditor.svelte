<script lang="ts">
import type {
  ContentGovernanceAssignmentData,
  ContentGovernanceProfileData,
} from '../../mock-smrt-client';

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

<form class="governance-editor" onsubmit={(event) => {
  event.preventDefault();
  handleSubmit();
}}>
  <label>
    Label
    <input type="text" bind:value={draft.label} />
  </label>
  <label>
    Content type
    <input type="text" bind:value={draft.contentType} required />
  </label>
  <label>
    Content variant
    <input type="text" bind:value={draft.contentVariant} />
  </label>
  <label>
    Publication profile
    <select bind:value={draft.publicationProfileKey}>
      <option value="" disabled={profiles.length > 0}>Select a profile</option>
      {#each profiles as profile (profile.key)}
        <option value={profile.key}>{profile.label}</option>
      {/each}
    </select>
  </label>
  <label>
    Correction profile
    <select bind:value={draft.correctionProfileKey}>
      <option value="" disabled={profiles.length > 0}>Select a profile</option>
      {#each profiles as profile (profile.key)}
        <option value={profile.key}>{profile.label}</option>
      {/each}
    </select>
  </label>
  <label>
    Default fact relationship
    <select bind:value={draft.defaultFactRelationship}>
      <option value="supports">supports</option>
      <option value="referenced_in">referenced_in</option>
      <option value="contradicts">contradicts</option>
      <option value="related">related</option>
    </select>
  </label>

  <div class="checkbox-grid">
    <label class="checkbox">
      <input type="checkbox" bind:checked={draft.enabled} />
      Enabled
    </label>
    <label class="checkbox">
      <input type="checkbox" bind:checked={draft.factLinkingEnabled} />
      Fact linking
    </label>
    <label class="checkbox">
      <input type="checkbox" bind:checked={draft.transparencyEnabled} />
      Transparency
    </label>
    <label class="checkbox">
      <input type="checkbox" bind:checked={draft.enforcePublishReadiness} />
      Enforce publish readiness
    </label>
  </div>

  <div class="actions">
    <button type="submit">Save assignment</button>
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
  select {
    width: 100%;
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
