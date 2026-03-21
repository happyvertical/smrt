<script lang="ts">
import { onMount } from 'svelte';
import {
  type ContentContributionData,
  type ContentContributionTypeData,
  type ContentContributorData,
  createClient,
} from '../../mock-smrt-client';
import ContentContributionForm from '../../svelte/components/ContentContributionForm.svelte';
import ContentContributionInbox from '../../svelte/components/ContentContributionInbox.svelte';
import ContentContributionTypeManager from '../../svelte/components/ContentContributionTypeManager.svelte';
import ContentContributorManager from '../../svelte/components/ContentContributorManager.svelte';

const client = createClient('/api/v1');

type Tab = 'inbox' | 'submit' | 'contributors' | 'types';
let activeTab = $state<Tab>('inbox');

let contributions = $state<ContentContributionData[]>([]);
let contributionTypes = $state<ContentContributionTypeData[]>([]);
let contributors = $state<ContentContributorData[]>([]);
let selectedContributionId = $state<string | null>(null);
let loading = $state(true);
let error = $state<string | null>(null);

const tabs: { key: Tab; label: string; icon: string }[] = [
  { key: 'inbox', label: 'Inbox', icon: '📥' },
  { key: 'submit', label: 'Submit', icon: '✍️' },
  { key: 'contributors', label: 'Contributors', icon: '👥' },
  { key: 'types', label: 'Types', icon: '⚙️' },
];

onMount(() => void loadAll());

async function loadAll() {
  loading = true;
  error = null;
  try {
    const [inbox, types, contribs] = await Promise.all([
      client.contentContributions.listInbox(),
      client.contentContributions.getContributionTypes(),
      client.contentContributors.list(),
    ]);
    contributions = inbox.data;
    contributionTypes = types.data.effective ?? types.data.persisted ?? [];
    contributors = contribs.data;
  } catch (err: any) {
    error = err.message;
  } finally {
    loading = false;
  }
}

async function handleApprove(
  contribution: ContentContributionData,
  options: { targetStatus: string; note: string },
) {
  if (!contribution.id) return;
  error = null;
  try {
    await client.contentContributions.approve(contribution.id, {
      editorNote: options.note,
      targetStatus: options.targetStatus,
    });
    await loadAll();
  } catch (err: any) {
    error = err?.message ?? 'Failed to approve contribution';
  }
}

async function handleReject(
  contribution: ContentContributionData,
  options: { note: string },
) {
  if (!contribution.id) return;
  error = null;
  try {
    await client.contentContributions.reject(contribution.id, {
      editorNote: options.note,
    });
    await loadAll();
  } catch (err: any) {
    error = err?.message ?? 'Failed to reject contribution';
  }
}

async function handleRequestChanges(
  contribution: ContentContributionData,
  options: { note: string },
) {
  if (!contribution.id) return;
  error = null;
  try {
    await client.contentContributions.requestChanges(contribution.id, {
      editorNote: options.note,
    });
    await loadAll();
  } catch (err: any) {
    error = err?.message ?? 'Failed to request changes';
  }
}

async function handleSubmit(payload: any) {
  error = null;
  try {
    // Convert File objects to attachment metadata for the API
    const attachments = (payload.files ?? []).map((file: File) => ({
      filename: file.name,
      mimeType: file.type,
      size: file.size,
    }));
    const { files: _files, ...rest } = payload;
    await client.contentContributions.submitWebContribution({
      ...rest,
      attachments,
      channel: 'web',
    });
    activeTab = 'inbox';
    await loadAll();
  } catch (err: any) {
    error = err?.message ?? 'Failed to submit contribution';
  }
}

async function handleSaveContributor(data: Partial<ContentContributorData>) {
  if (data.id) {
    await client.contentContributors.update(data.id, data);
  } else {
    await client.contentContributors.create(data);
  }
  await loadAll();
}

async function handleDeleteContributor(contributor: ContentContributorData) {
  if (contributor.id) {
    await client.contentContributors.delete(contributor.id);
    await loadAll();
  }
}

async function handleSaveType(data: Partial<ContentContributionTypeData>) {
  if (data.id) {
    await client.contentContributionTypes.update(data.id, data);
  } else {
    await client.contentContributionTypes.create(data);
  }
  await loadAll();
}

async function handleDeleteType(type: ContentContributionTypeData) {
  if (type.id) {
    await client.contentContributionTypes.delete(type.id);
    await loadAll();
  }
}
</script>

<div class="page">
  <div class="page-header">
    <h1>📬 Contributions</h1>
    <p>Manage incoming content contributions, review submissions, and configure contribution types.</p>
  </div>

  <div class="sub-tabs">
    {#each tabs as tab}
      <button
        class="sub-tab"
        class:active={activeTab === tab.key}
        onclick={() => (activeTab = tab.key)}
      >
        <span>{tab.icon}</span> {tab.label}
      </button>
    {/each}
  </div>

  <div class="page-card">
    {#if loading}
      <p class="loading">Loading contributions data...</p>
    {:else if error}
      <div class="error-box">
        <p>{error}</p>
        <button onclick={() => void loadAll()}>Retry</button>
      </div>
    {:else if activeTab === 'inbox'}
      <ContentContributionInbox
        {contributions}
        selectedId={selectedContributionId}
        onSelect={(c) => (selectedContributionId = c.id ?? null)}
        onApprove={handleApprove}
        onReject={handleReject}
        onRequestChanges={handleRequestChanges}
      />
    {:else if activeTab === 'submit'}
      <ContentContributionForm
        types={contributionTypes}
        onSubmit={handleSubmit}
        onCancel={() => (activeTab = 'inbox')}
      />
    {:else if activeTab === 'contributors'}
      <ContentContributorManager
        {contributors}
        onSave={handleSaveContributor}
        onDelete={handleDeleteContributor}
      />
    {:else if activeTab === 'types'}
      <ContentContributionTypeManager
        types={contributionTypes}
        onSave={handleSaveType}
        onDelete={handleDeleteType}
      />
    {/if}
  </div>
</div>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .page-header {
    text-align: center;
    padding: 1rem 0;
  }

  .page-header h1 {
    margin: 0 0 0.5rem 0;
    font-size: 2rem;
    font-weight: 800;
    color: var(--smrt-color-on-background, #1a1c1e);
  }

  .page-header p {
    margin: 0 auto;
    color: var(--smrt-color-on-surface-variant, #43474e);
    font-size: 1.05rem;
    max-width: 600px;
  }

  .sub-tabs {
    display: flex;
    gap: 0.35rem;
    justify-content: center;
    flex-wrap: wrap;
  }

  .sub-tab {
    display: flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.45rem 0.9rem;
    border: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
    border-radius: 999px;
    background: var(--smrt-color-surface, #fff);
    color: var(--smrt-color-on-surface-variant, #43474e);
    font-size: 0.8125rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.15s;
  }

  .sub-tab:hover {
    background: var(--smrt-color-surface-variant, #e1e2ec);
  }

  .sub-tab.active {
    background: var(--smrt-color-primary-container, #d8e2ff);
    color: var(--smrt-color-on-primary-container, #001a41);
    border-color: var(--smrt-color-primary-container, #d8e2ff);
    font-weight: 600;
  }

  .page-card {
    background: var(--smrt-color-surface, #fff);
    border: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
    border-radius: 1rem;
    padding: 1.5rem;
    box-shadow: 0 2px 8px rgba(0,0,0,0.04);
  }

  .loading {
    text-align: center;
    padding: 2rem;
    color: var(--smrt-color-on-surface-variant, #74777f);
  }

  .error-box {
    text-align: center;
    padding: 1.5rem;
    background: var(--smrt-color-error-container, #ffdad6);
    border-radius: 0.75rem;
    color: var(--smrt-color-on-error-container, #410002);
  }

  .error-box button {
    margin-top: 0.75rem;
    padding: 0.4rem 1rem;
    border: 1px solid currentColor;
    border-radius: 0.375rem;
    background: transparent;
    cursor: pointer;
    font-weight: 500;
  }
</style>
