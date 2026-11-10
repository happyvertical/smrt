<script lang="ts">
import { Button } from '@happyvertical/smrt-ui/ui';

let activeGroup = $state<string>('contents');
let tryEndpoint = $state<{ method: string; path: string } | null>(null);
let tryResult = $state<string | null>(null);
let tryLoading = $state(false);
let tryError = $state<string | null>(null);

interface Endpoint {
  method: string;
  path: string;
  description: string;
}

interface EndpointGroup {
  key: string;
  label: string;
  icon: string;
  endpoints: Endpoint[];
}

const groups: EndpointGroup[] = [
  {
    key: 'contents',
    label: 'Contents',
    icon: '📝',
    endpoints: [
      {
        method: 'GET',
        path: '/api/v1/contents',
        description: 'List all contents',
      },
      {
        method: 'POST',
        path: '/api/v1/contents',
        description: 'Create content',
      },
      {
        method: 'GET',
        path: '/api/v1/contents/{id}',
        description: 'Get content by ID',
      },
      {
        method: 'PUT',
        path: '/api/v1/contents/{id}',
        description: 'Update content',
      },
      {
        method: 'DELETE',
        path: '/api/v1/contents/{id}',
        description: 'Delete content',
      },
      {
        method: 'GET',
        path: '/api/v1/contents/by-slug?slug=...',
        description: 'Get content by slug',
      },
      {
        method: 'GET',
        path: '/api/v1/contents/facts',
        description: 'Browse fact catalog',
      },
      {
        method: 'GET',
        path: '/api/v1/contents/{id}/facts',
        description: 'Get facts for content',
      },
      {
        method: 'PUT',
        path: '/api/v1/contents/{id}/facts',
        description: 'Sync facts for content',
      },
      {
        method: 'GET',
        path: '/api/v1/contents/{id}/reviews',
        description: 'List reviews for content',
      },
      {
        method: 'POST',
        path: '/api/v1/contents/{id}/reviews',
        description: 'Run AI review on content',
      },
      {
        method: 'GET',
        path: '/api/v1/contents/{id}/review-profiles',
        description: 'Get review readiness profiles',
      },
      {
        method: 'GET',
        path: '/api/v1/contents/{id}/corrections',
        description: 'List corrections',
      },
      {
        method: 'POST',
        path: '/api/v1/contents/{id}/corrections',
        description: 'Issue correction',
      },
      {
        method: 'GET',
        path: '/api/v1/contents/{id}/versions',
        description: 'List content versions',
      },
      {
        method: 'POST',
        path: '/api/v1/contents/{id}/versions',
        description: 'Create version snapshot',
      },
      {
        method: 'GET',
        path: '/api/v1/contents/{id}/transparency',
        description: 'Published transparency',
      },
      {
        method: 'GET',
        path: '/api/v1/contents/{id}/transparency/preview',
        description: 'Preview transparency',
      },
      {
        method: 'GET',
        path: '/api/v1/contents/{id}/chat',
        description: 'Get chat session for content',
      },
      {
        method: 'POST',
        path: '/api/v1/contents/{id}/chat',
        description: 'Create chat thread',
      },
    ],
  },
  {
    key: 'governance',
    label: 'Governance',
    icon: '🛡️',
    endpoints: [
      {
        method: 'GET',
        path: '/api/v1/contents/governance',
        description: 'Get governance definitions (effective + persisted)',
      },
      {
        method: 'GET',
        path: '/api/v1/contents/governance/resolve?type=article',
        description: 'Resolve governance for content type',
      },
      {
        method: 'GET',
        path: '/api/v1/contents/{id}/governance',
        description: 'Get governance state for content',
      },
      {
        method: 'GET',
        path: '/api/v1/contentgovernancepolicies',
        description: 'List governance policies',
      },
      {
        method: 'POST',
        path: '/api/v1/contentgovernancepolicies',
        description: 'Create policy',
      },
      {
        method: 'GET',
        path: '/api/v1/contentgovernancepolicies/{id}',
        description: 'Get policy',
      },
      {
        method: 'PUT',
        path: '/api/v1/contentgovernancepolicies/{id}',
        description: 'Update policy',
      },
      {
        method: 'DELETE',
        path: '/api/v1/contentgovernancepolicies/{id}',
        description: 'Delete policy',
      },
      {
        method: 'GET',
        path: '/api/v1/contentgovernanceprofiles',
        description: 'List profiles',
      },
      {
        method: 'POST',
        path: '/api/v1/contentgovernanceprofiles',
        description: 'Create profile',
      },
      {
        method: 'GET',
        path: '/api/v1/contentgovernanceassignments',
        description: 'List assignments',
      },
      {
        method: 'POST',
        path: '/api/v1/contentgovernanceassignments',
        description: 'Create assignment',
      },
    ],
  },
  {
    key: 'contributions',
    label: 'Contributions',
    icon: '📬',
    endpoints: [
      {
        method: 'GET',
        path: '/api/v1/contentcontributions',
        description: 'List all contributions',
      },
      {
        method: 'POST',
        path: '/api/v1/contentcontributions/submit',
        description: 'Submit web contribution',
      },
      {
        method: 'POST',
        path: '/api/v1/contentcontributions/ingest-email',
        description: 'Ingest email contribution',
      },
      {
        method: 'GET',
        path: '/api/v1/contentcontributions/inbox',
        description: 'Editorial inbox (held items)',
      },
      {
        method: 'GET',
        path: '/api/v1/contentcontributions/by-contributor?email=...',
        description: 'Contributions by contributor',
      },
      {
        method: 'GET',
        path: '/api/v1/contentcontributions/types',
        description: 'Get contribution type config',
      },
      {
        method: 'GET',
        path: '/api/v1/contentcontributions/{id}',
        description: 'Get contribution',
      },
      {
        method: 'POST',
        path: '/api/v1/contentcontributions/{id}/approve',
        description: 'Approve contribution',
      },
      {
        method: 'POST',
        path: '/api/v1/contentcontributions/{id}/reject',
        description: 'Reject contribution',
      },
      {
        method: 'POST',
        path: '/api/v1/contentcontributions/{id}/request-changes',
        description: 'Request changes',
      },
      {
        method: 'POST',
        path: '/api/v1/contentcontributions/{id}/withdraw',
        description: 'Withdraw contribution',
      },
      {
        method: 'POST',
        path: '/api/v1/contentcontributions/{id}/promote',
        description: 'Promote to content',
      },
      {
        method: 'POST',
        path: '/api/v1/contentcontributions/{id}/revisions',
        description: 'Append revision',
      },
    ],
  },
  {
    key: 'contributors',
    label: 'Contributors',
    icon: '👥',
    endpoints: [
      {
        method: 'GET',
        path: '/api/v1/contentcontributors',
        description: 'List contributors',
      },
      {
        method: 'POST',
        path: '/api/v1/contentcontributors',
        description: 'Create contributor',
      },
      {
        method: 'GET',
        path: '/api/v1/contentcontributors/{id}',
        description: 'Get contributor',
      },
      {
        method: 'PUT',
        path: '/api/v1/contentcontributors/{id}',
        description: 'Update contributor',
      },
      {
        method: 'DELETE',
        path: '/api/v1/contentcontributors/{id}',
        description: 'Delete contributor',
      },
      {
        method: 'GET',
        path: '/api/v1/contentcontributors/getByEmail?email=...',
        description: 'Find by email',
      },
      {
        method: 'GET',
        path: '/api/v1/contentcontributors/getByProfileId?profileId=...',
        description: 'Find by profile',
      },
    ],
  },
  {
    key: 'types',
    label: 'Contribution Types',
    icon: '⚙️',
    endpoints: [
      {
        method: 'GET',
        path: '/api/v1/contentcontributiontypes',
        description: 'List types',
      },
      {
        method: 'POST',
        path: '/api/v1/contentcontributiontypes',
        description: 'Create type',
      },
      {
        method: 'GET',
        path: '/api/v1/contentcontributiontypes/{id}',
        description: 'Get type',
      },
      {
        method: 'PUT',
        path: '/api/v1/contentcontributiontypes/{id}',
        description: 'Update type',
      },
      {
        method: 'DELETE',
        path: '/api/v1/contentcontributiontypes/{id}',
        description: 'Delete type',
      },
    ],
  },
  {
    key: 'references',
    label: 'References',
    icon: '🔗',
    endpoints: [
      {
        method: 'GET',
        path: '/api/v1/contentreferences',
        description: 'List references',
      },
      {
        method: 'POST',
        path: '/api/v1/contentreferences',
        description:
          'Create a reference (sourceId, targetId) — upsert; rewrites id/createdAt on duplicates',
      },
      {
        method: 'POST',
        path: '/api/v1/contentreferences/attach',
        description:
          'Create-or-find a reference idempotently — preserves id/createdAt on duplicates',
      },
      {
        method: 'GET',
        path: '/api/v1/contentreferences/[id]',
        description: 'Get reference by id',
      },
    ],
  },
  {
    key: 'reviews',
    label: 'Reviews & Corrections',
    icon: '📋',
    endpoints: [
      {
        method: 'GET',
        path: '/api/v1/contentreviews',
        description: 'List all reviews',
      },
      {
        method: 'GET',
        path: '/api/v1/contentreviews/{id}',
        description: 'Get review',
      },
      {
        method: 'GET',
        path: '/api/v1/contentcorrections',
        description: 'List all corrections',
      },
      {
        method: 'GET',
        path: '/api/v1/contentcorrections/{id}',
        description: 'Get correction',
      },
      {
        method: 'POST',
        path: '/api/v1/contentcorrections/issue',
        description: 'Issue correction (standalone)',
      },
      {
        method: 'GET',
        path: '/api/v1/contentcorrections/listForContent?contentId=...',
        description: 'Corrections for content',
      },
      {
        method: 'GET',
        path: '/api/v1/contentversions/{id}/transparency',
        description: 'Version transparency',
      },
    ],
  },
];

const activeGroupData = $derived(
  groups.find((g) => g.key === activeGroup) || groups[0],
);

function methodColor(method: string): string {
  switch (method) {
    case 'GET':
      return '#10b981';
    case 'POST':
      return '#3b82f6';
    case 'PUT':
      return '#f59e0b';
    case 'DELETE':
      return '#ef4444';
    default:
      return '#6b7280';
  }
}

function canTry(endpoint: Endpoint): boolean {
  return endpoint.method === 'GET' && !endpoint.path.includes('{id}');
}

async function handleTry(endpoint: Endpoint) {
  tryEndpoint = endpoint;
  tryLoading = true;
  tryResult = null;
  tryError = null;

  try {
    const res = await fetch(endpoint.path);
    const data = await res.json();
    tryResult = JSON.stringify(data, null, 2);
  } catch (err) {
    tryError = err instanceof Error ? err.message : String(err);
  } finally {
    tryLoading = false;
  }
}

function closeTry() {
  tryEndpoint = null;
  tryResult = null;
  tryError = null;
}
</script>

<div class="smrt-api-explorer__root" data-smrt-component="ApiExplorer">
  <div class="smrt-api-explorer__header" data-smrt-part="header">
    <h1>🔌 API Explorer</h1>
    <p>Browse and test the {groups.reduce((n, g) => n + g.endpoints.length, 0)} auto-generated REST endpoints from the Content Service.</p>
  </div>

  <div class="smrt-api-explorer__layout" data-smrt-part="body">
    <aside class="smrt-api-explorer__nav" data-smrt-part="nav">
      {#each groups as group}
        <Button
          variant="ghost"
          class={`group-btn${activeGroup === group.key ? ' group-btn--active' : ''}`}
          aria-pressed={activeGroup === group.key}
          onclick={() => { activeGroup = group.key; closeTry(); }}
        >
          <span class="smrt-api-explorer__icon" data-smrt-part="icon">{group.icon}</span>
          <span class="smrt-api-explorer__label" data-smrt-part="label">{group.label}</span>
          <span class="smrt-api-explorer__count" data-smrt-part="count">{group.endpoints.length}</span>
        </Button>
      {/each}
    </aside>

    <div class="smrt-api-explorer__panel" data-smrt-part="panel">
      <h2>{activeGroupData.icon} {activeGroupData.label}</h2>

      <div class="smrt-api-explorer__list" data-smrt-part="list">
        {#each activeGroupData.endpoints as endpoint}
          <div class="smrt-api-explorer__row" data-smrt-part="row">
            <span class="smrt-api-explorer__badge" data-smrt-part="badge" style="background: {methodColor(endpoint.method)}">{endpoint.method}</span>
            <code class="smrt-api-explorer__path" data-smrt-part="meta">{endpoint.path}</code>
            <span class="smrt-api-explorer__desc" data-smrt-part="description">{endpoint.description}</span>
            {#if canTry(endpoint)}
              <Button variant="ghost" size="sm" class="try-btn" onclick={() => void handleTry(endpoint)}>Try</Button>
            {/if}
          </div>
        {/each}
      </div>

      {#if tryEndpoint}
        <div class="smrt-api-explorer__try-panel" data-smrt-part="group">
          <div class="smrt-api-explorer__try-header" data-smrt-part="actions">
            <span class="smrt-api-explorer__badge" data-smrt-part="badge" style="background: {methodColor(tryEndpoint.method)}">{tryEndpoint.method}</span>
            <code>{tryEndpoint.path}</code>
            <Button variant="ghost" size="sm" class="close-btn" onclick={closeTry} aria-label="Close" title="Close">✕</Button>
          </div>
          {#if tryLoading}
            <p class="smrt-api-explorer__try-loading" data-smrt-part="status">Fetching...</p>
          {:else if tryError}
            <pre class="smrt-api-explorer__try-error" data-smrt-part="error">{tryError}</pre>
          {:else if tryResult}
            <pre class="smrt-api-explorer__try-result" data-smrt-part="panel">{tryResult}</pre>
          {/if}
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-api-explorer__root {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }
  .smrt-api-explorer__header {
    padding: 1rem 0;
  }
  .smrt-api-explorer__header h1 {
    margin: 0 0 0.5rem 0;
  }
  .smrt-api-explorer__header p {
    margin: 0 auto;
    max-width: 600px;
  }
  .smrt-api-explorer__layout {
    display: grid;
    grid-template-columns: 200px 1fr;
    gap: 1rem;
    align-items: start;
  }
  .smrt-api-explorer__nav {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    position: sticky;
    top: 70px;
  }
  .smrt-api-explorer__nav :global(.group-btn) {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.6rem 0.75rem;
    cursor: pointer;
  }
  .smrt-api-explorer__label {
    flex: 1;
  }
  .smrt-api-explorer__count {
    padding: 0.1rem 0.4rem;
  }
  .smrt-api-explorer__panel {
    padding: 1.5rem;
  }
  .smrt-api-explorer__panel h2 {
    margin: 0 0 1rem 0;
  }
  .smrt-api-explorer__list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .smrt-api-explorer__row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.5rem 0.75rem;
    flex-wrap: wrap;
  }
  .smrt-api-explorer__badge {
    display: inline-flex;
    align-items: center;
    padding: 0.15rem 0.45rem;
    min-width: 3rem;
    justify-content: center;
  }
  .smrt-api-explorer__path {
    word-break: break-all;
  }
  .smrt-api-explorer__desc {
    flex: 1;
  }
  .smrt-api-explorer__row :global(.try-btn) {
    padding: 0.2rem 0.6rem;
    cursor: pointer;
  }
  .smrt-api-explorer__try-panel {
    margin-top: 1rem;
    overflow: hidden;
  }
  .smrt-api-explorer__try-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.6rem 0.75rem;
  }
  .smrt-api-explorer__try-header code {
    flex: 1;
  }
  .smrt-api-explorer__try-header :global(.close-btn) {
    cursor: pointer;
    padding: 0.2rem 0.4rem;
  }
  .smrt-api-explorer__try-loading {
    padding: 1rem;
    margin: 0;
  }
  .smrt-api-explorer__try-result, .smrt-api-explorer__try-error {
    margin: 0;
    padding: 1rem;
    max-height: 400px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }
  @media (max-width: 768px) {
    .smrt-api-explorer__layout {
      grid-template-columns: 1fr;
    }
    .smrt-api-explorer__nav {
      flex-direction: row;
      overflow-x: auto;
      flex-wrap: nowrap;
      position: static;
    }
    .smrt-api-explorer__nav :global(.group-btn) {
      white-space: nowrap;
    }
  }
}

@layer smrt.theme {
  .smrt-api-explorer__header {
    text-align: center;
  }
  .smrt-api-explorer__header h1 {
    font-size: var(--smrt-typography-headline-large-size, 2rem);
    font-weight: var(--smrt-typography-weight-bold, 800);
  }
  .smrt-api-explorer__header p {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-large-size, 1.05rem);
  }
  .smrt-api-explorer__nav :global(.group-btn) {
    border: none;
    border-radius: 0.5rem;
    background: transparent;
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-label-large-size, 0.8125rem);
    text-align: left;
    transition: background 0.15s;
  }
  .smrt-api-explorer__nav :global(.group-btn:hover) {
    background: var(--smrt-color-surface-variant);
  }
  .smrt-api-explorer__nav :global(.group-btn.group-btn--active) {
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-on-primary-container);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-api-explorer__icon {
    font-size: var(--smrt-typography-title-medium-size, 1rem);
  }
  .smrt-api-explorer__count {
    background: var(--smrt-color-surface-variant);
    border-radius: var(--smrt-radius-full);
    font-size: var(--smrt-typography-label-small-size, 0.7rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-api-explorer__nav :global(.group-btn.group-btn--active .smrt-api-explorer__count) {
    background: color-mix(in srgb, var(--smrt-color-shadow) 8%, transparent);
  }
  .smrt-api-explorer__panel {
    background: var(--smrt-color-surface);
    border: var(--smrt-hairline);
    border-radius: 1rem;
    box-shadow: var(--smrt-elevation-3, 0 2px 8px color-mix(in srgb, var(--smrt-color-shadow) 4%, transparent));
  }
  .smrt-api-explorer__panel h2 {
    font-size: var(--smrt-typography-title-large-size, 1.25rem);
  }
  .smrt-api-explorer__row {
    border-radius: 0.5rem;
    background: var(--smrt-color-surface-container-low);
    font-size: var(--smrt-typography-body-medium-size, 0.8125rem);
  }
  .smrt-api-explorer__badge {
    border-radius: 0.25rem;
    color: white;
    font-size: var(--smrt-typography-label-small-size, 0.6875rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
    font-family: var(--smrt-font-family-mono, monospace);
  }
  .smrt-api-explorer__path {
    font-size: var(--smrt-typography-body-medium-size, 0.8125rem);
    color: var(--smrt-color-on-surface);
  }
  .smrt-api-explorer__desc {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    text-align: right;
  }
  .smrt-api-explorer__row :global(.try-btn) {
    border: 1px solid var(--smrt-color-primary);
    border-radius: 0.25rem;
    background: transparent;
    color: var(--smrt-color-primary);
    font-size: var(--smrt-typography-label-small-size, 0.6875rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    transition: all 0.15s;
  }
  .smrt-api-explorer__row :global(.try-btn:hover) {
    background: var(--smrt-color-primary);
    color: white;
  }
  .smrt-api-explorer__try-panel {
    border: var(--smrt-hairline);
    border-radius: 0.75rem;
  }
  .smrt-api-explorer__try-header {
    background: var(--smrt-color-surface-container-low);
    border-bottom: var(--smrt-hairline);
  }
  .smrt-api-explorer__try-header code {
    font-size: var(--smrt-typography-body-medium-size, 0.8125rem);
  }
  .smrt-api-explorer__try-header :global(.close-btn) {
    border: none;
    background: none;
    font-size: var(--smrt-typography-title-medium-size, 1rem);
    color: var(--smrt-color-on-surface-variant);
    border-radius: 0.25rem;
  }
  .smrt-api-explorer__try-header :global(.close-btn:hover) {
    background: var(--smrt-color-surface-variant);
  }
  .smrt-api-explorer__try-loading {
    text-align: center;
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-api-explorer__try-result, .smrt-api-explorer__try-error {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    line-height: var(--smrt-typography-body-small-line-height, 1.5);
  }
  .smrt-api-explorer__try-error {
    color: var(--smrt-color-error);
    background: var(--smrt-color-error-container);
  }
  .smrt-api-explorer__try-result {
    background: var(--smrt-color-surface-container-lowest);
  }
}

</style>
