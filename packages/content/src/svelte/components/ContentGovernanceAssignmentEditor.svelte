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
} = $props<Props>();

let label = $state(assignment.label || '');
let contentType = $state(assignment.contentType || 'article');
let contentVariant = $state(assignment.contentVariant || '');
let enabled = $state(assignment.enabled ?? true);
let factLinkingEnabled = $state(assignment.factLinkingEnabled ?? true);
let transparencyEnabled = $state(assignment.transparencyEnabled ?? true);
let publicationProfileKey = $state(
  assignment.publicationProfileKey || profiles[0]?.key || 'publication',
);
let correctionProfileKey = $state(
  assignment.correctionProfileKey || profiles[1]?.key || 'correction',
);
let enforcePublishReadiness = $state(
  assignment.enforcePublishReadiness ?? false,
);
let defaultFactRelationship = $state(
  assignment.defaultFactRelationship || 'supports',
);

function handleSubmit() {
  onSave({
    ...assignment,
    label,
    contentType,
    contentVariant: contentVariant || null,
    enabled,
    factLinkingEnabled,
    transparencyEnabled,
    publicationProfileKey: publicationProfileKey || null,
    correctionProfileKey: correctionProfileKey || null,
    enforcePublishReadiness,
    defaultFactRelationship,
  });
}
</script>

<form class="governance-editor" onsubmit={(event) => {
  event.preventDefault();
  handleSubmit();
}}>
  <label>
    Label
    <input type="text" bind:value={label} />
  </label>
  <label>
    Content type
    <input type="text" bind:value={contentType} required />
  </label>
  <label>
    Content variant
    <input type="text" bind:value={contentVariant} />
  </label>
  <label>
    Publication profile
    <select bind:value={publicationProfileKey}>
      {#each profiles as profile (profile.key)}
        <option value={profile.key}>{profile.label}</option>
      {/each}
    </select>
  </label>
  <label>
    Correction profile
    <select bind:value={correctionProfileKey}>
      {#each profiles as profile (profile.key)}
        <option value={profile.key}>{profile.label}</option>
      {/each}
    </select>
  </label>
  <label>
    Default fact relationship
    <select bind:value={defaultFactRelationship}>
      <option value="supports">supports</option>
      <option value="referenced_in">referenced_in</option>
      <option value="contradicts">contradicts</option>
      <option value="related">related</option>
    </select>
  </label>

  <div class="checkbox-grid">
    <label class="checkbox">
      <input type="checkbox" bind:checked={enabled} />
      Enabled
    </label>
    <label class="checkbox">
      <input type="checkbox" bind:checked={factLinkingEnabled} />
      Fact linking
    </label>
    <label class="checkbox">
      <input type="checkbox" bind:checked={transparencyEnabled} />
      Transparency
    </label>
    <label class="checkbox">
      <input type="checkbox" bind:checked={enforcePublishReadiness} />
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
    font-size: 0.9rem;
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
