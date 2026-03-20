<script lang="ts">
import { onMount } from 'svelte';
import {
  type ContentGovernanceAssignmentData,
  type ContentGovernanceDefinitionsData,
  type ContentGovernanceProfileData,
  type ContentReviewPolicyData,
  createClient,
} from '../../mock-smrt-client';
import ContentGovernanceAssignmentEditor from './ContentGovernanceAssignmentEditor.svelte';
import ContentGovernancePolicyEditor from './ContentGovernancePolicyEditor.svelte';
import ContentGovernanceProfileEditor from './ContentGovernanceProfileEditor.svelte';

const client = createClient('/api/v1');

type EditMode = 'policy' | 'profile' | 'assignment' | null;

export interface Props {
  onChange?: (definitions: ContentGovernanceDefinitionsData | null) => void;
}

let { onChange = undefined }: Props = $props();

let definitions = $state<ContentGovernanceDefinitionsData | null>(null);
let loading = $state(true);
let error = $state<string | null>(null);
let editMode = $state<EditMode>(null);
let editingPolicy = $state<ContentReviewPolicyData | null>(null);
let editingProfile = $state<ContentGovernanceProfileData | null>(null);
let editingAssignment = $state<ContentGovernanceAssignmentData | null>(null);

onMount(async () => {
  await loadDefinitions();
});

async function loadDefinitions() {
  loading = true;
  error = null;

  try {
    const response = await client.contents.getGovernanceDefinitions();
    definitions = response.data;
    onChange?.(response.data);
  } catch (err: any) {
    error = err.message || 'Failed to load governance definitions';
  } finally {
    loading = false;
  }
}

async function savePolicy(policy: Partial<ContentReviewPolicyData>) {
  if (editingPolicy?.id) {
    await client.contentGovernancePolicies.update(editingPolicy.id, policy);
  } else {
    await client.contentGovernancePolicies.create(policy);
  }

  editMode = null;
  editingPolicy = null;
  await loadDefinitions();
}

async function saveProfile(profile: Partial<ContentGovernanceProfileData>) {
  if (editingProfile?.id) {
    await client.contentGovernanceProfiles.update(editingProfile.id, profile);
  } else {
    await client.contentGovernanceProfiles.create(profile);
  }

  editMode = null;
  editingProfile = null;
  await loadDefinitions();
}

async function saveAssignment(
  assignment: Partial<ContentGovernanceAssignmentData>,
) {
  if (editingAssignment?.id) {
    await client.contentGovernanceAssignments.update(
      editingAssignment.id,
      assignment,
    );
  } else {
    await client.contentGovernanceAssignments.create(assignment);
  }

  editMode = null;
  editingAssignment = null;
  await loadDefinitions();
}

async function deletePolicy(id?: string) {
  if (!id) return;
  await client.contentGovernancePolicies.delete(id);
  await loadDefinitions();
}

async function deleteProfile(id?: string) {
  if (!id) return;
  await client.contentGovernanceProfiles.delete(id);
  await loadDefinitions();
}

async function deleteAssignment(id?: string) {
  if (!id) return;
  await client.contentGovernanceAssignments.delete(id);
  await loadDefinitions();
}

function cancelEditing() {
  editMode = null;
  editingPolicy = null;
  editingProfile = null;
  editingAssignment = null;
}
</script>

<div class="governance-manager">
  <div class="governance-manager__header">
    <div>
      <h3>Content Governance</h3>
      <p>Manage effective policies, profiles, and type assignments for governed content.</p>
    </div>
    <button type="button" class="secondary" onclick={() => void loadDefinitions()}>
      Refresh
    </button>
  </div>

  {#if loading}
    <p>Loading governance definitions...</p>
  {:else if error}
    <p class="error">{error}</p>
  {:else if definitions}
    <div class="governance-manager__grid">
      <section>
        <div class="section-header">
          <h4>Policies</h4>
          <button type="button" onclick={() => {
            editMode = 'policy';
            editingPolicy = null;
          }}>
            Add policy
          </button>
        </div>
        {#if editMode === 'policy'}
          {#key editingPolicy?.id ?? editingPolicy?.key ?? 'new-policy'}
            <ContentGovernancePolicyEditor
              policy={editingPolicy || {}}
              onSave={savePolicy}
              onCancel={cancelEditing}
            />
          {/key}
        {/if}
        <div class="list">
          {#each definitions.effective.policies as policy (policy.key)}
            <article class="card">
              <div>
                <strong>{policy.label}</strong>
                <span>{policy.key} · {policy.kind}</span>
              </div>
              <div class="actions">
                <button type="button" class="secondary" onclick={() => {
                  editMode = 'policy';
                  editingPolicy = policy;
                }}>
                  Edit
                </button>
                {#if definitions.persisted.policies.some((item) => item.key === policy.key)}
                  <button type="button" class="secondary" onclick={() => void deletePolicy(policy.id)}>
                    Delete override
                  </button>
                {/if}
              </div>
            </article>
          {/each}
        </div>
      </section>

      <section>
        <div class="section-header">
          <h4>Profiles</h4>
          <button type="button" onclick={() => {
            editMode = 'profile';
            editingProfile = null;
          }}>
            Add profile
          </button>
        </div>
        {#if editMode === 'profile'}
          {#key editingProfile?.id ?? editingProfile?.key ?? 'new-profile'}
            <ContentGovernanceProfileEditor
              profile={editingProfile || {}}
              policies={definitions.effective.policies}
              onSave={saveProfile}
              onCancel={cancelEditing}
            />
          {/key}
        {/if}
        <div class="list">
          {#each definitions.effective.profiles as profile (profile.key)}
            <article class="card">
              <div>
                <strong>{profile.label}</strong>
                <span>{profile.key} · {profile.requirements.length} requirement(s)</span>
              </div>
              <div class="actions">
                <button type="button" class="secondary" onclick={() => {
                  editMode = 'profile';
                  editingProfile = profile;
                }}>
                  Edit
                </button>
                {#if definitions.persisted.profiles.some((item) => item.key === profile.key)}
                  <button type="button" class="secondary" onclick={() => void deleteProfile(profile.id)}>
                    Delete override
                  </button>
                {/if}
              </div>
            </article>
          {/each}
        </div>
      </section>

      <section>
        <div class="section-header">
          <h4>Assignments</h4>
          <button type="button" onclick={() => {
            editMode = 'assignment';
            editingAssignment = null;
          }}>
            Add assignment
          </button>
        </div>
        {#if editMode === 'assignment'}
          {#key editingAssignment?.id ?? editingAssignment?.key ?? 'new-assignment'}
            <ContentGovernanceAssignmentEditor
              assignment={editingAssignment || {}}
              profiles={definitions.effective.profiles}
              onSave={saveAssignment}
              onCancel={cancelEditing}
            />
          {/key}
        {/if}
        <div class="list">
          {#each definitions.effective.assignments as assignment (assignment.key)}
            <article class="card">
              <div>
                <strong>{assignment.label || assignment.contentType}</strong>
                <span>
                  {assignment.contentType}
                  {assignment.contentVariant ? ` · ${assignment.contentVariant}` : ''}
                </span>
              </div>
              <div class="actions">
                <button type="button" class="secondary" onclick={() => {
                  editMode = 'assignment';
                  editingAssignment = assignment;
                }}>
                  Edit
                </button>
                {#if assignment.id}
                  <button type="button" class="secondary" onclick={() => void deleteAssignment(assignment.id)}>
                    Delete
                  </button>
                {/if}
              </div>
            </article>
          {/each}
        </div>
      </section>
    </div>
  {/if}
</div>

<style>
  .governance-manager {
    display: grid;
    gap: 1rem;
  }

  .governance-manager__header,
  .section-header,
  .actions {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .governance-manager__grid {
    display: grid;
    gap: 1rem;
  }

  .list {
    display: grid;
    gap: 0.75rem;
    margin-top: 0.75rem;
  }

  .card {
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 0.75rem;
    padding: 0.85rem;
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .card div:first-child {
    display: grid;
    gap: 0.35rem;
  }

  .error {
    color: var(--smrt-color-error);
  }
</style>
