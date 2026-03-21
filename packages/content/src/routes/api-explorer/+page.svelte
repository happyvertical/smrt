<script lang="ts">
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
        path: '/api/v1/contentreferences/link',
        description: 'Link content reference',
      },
      {
        method: 'POST',
        path: '/api/v1/contentreferences/unlink',
        description: 'Unlink reference',
      },
      {
        method: 'GET',
        path: '/api/v1/contentreferences/getForSource?contentId=...',
        description: 'Get by source content',
      },
      {
        method: 'GET',
        path: '/api/v1/contentreferences/getForTarget?targetId=...',
        description: 'Get by target content',
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
  } catch (err: any) {
    tryError = err.message;
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

<div class="page">
  <div class="page-header">
    <h1>🔌 API Explorer</h1>
    <p>Browse and test the {groups.reduce((n, g) => n + g.endpoints.length, 0)} auto-generated REST endpoints from the Content Service.</p>
  </div>

  <div class="explorer-layout">
    <aside class="group-nav">
      {#each groups as group}
        <button
          class="group-btn"
          class:active={activeGroup === group.key}
          onclick={() => { activeGroup = group.key; closeTry(); }}
        >
          <span class="group-icon">{group.icon}</span>
          <span class="group-label">{group.label}</span>
          <span class="group-count">{group.endpoints.length}</span>
        </button>
      {/each}
    </aside>

    <div class="endpoints-panel">
      <h2>{activeGroupData.icon} {activeGroupData.label}</h2>

      <div class="endpoint-list">
        {#each activeGroupData.endpoints as endpoint}
          <div class="endpoint-row">
            <span class="method-badge" style="background: {methodColor(endpoint.method)}">{endpoint.method}</span>
            <code class="endpoint-path">{endpoint.path}</code>
            <span class="endpoint-desc">{endpoint.description}</span>
            {#if canTry(endpoint)}
              <button class="try-btn" onclick={() => void handleTry(endpoint)}>Try</button>
            {/if}
          </div>
        {/each}
      </div>

      {#if tryEndpoint}
        <div class="try-panel">
          <div class="try-header">
            <span class="method-badge" style="background: {methodColor(tryEndpoint.method)}">{tryEndpoint.method}</span>
            <code>{tryEndpoint.path}</code>
            <button class="close-btn" onclick={closeTry}>✕</button>
          </div>
          {#if tryLoading}
            <p class="try-loading">Fetching...</p>
          {:else if tryError}
            <pre class="try-error">{tryError}</pre>
          {:else if tryResult}
            <pre class="try-result">{tryResult}</pre>
          {/if}
        </div>
      {/if}
    </div>
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
  }

  .page-header p {
    margin: 0 auto;
    color: var(--smrt-color-on-surface-variant, #43474e);
    font-size: 1.05rem;
    max-width: 600px;
  }

  .explorer-layout {
    display: grid;
    grid-template-columns: 200px 1fr;
    gap: 1rem;
    align-items: start;
  }

  .group-nav {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    position: sticky;
    top: 70px;
  }

  .group-btn {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.6rem 0.75rem;
    border: none;
    border-radius: 0.5rem;
    background: transparent;
    color: var(--smrt-color-on-surface-variant, #43474e);
    cursor: pointer;
    font-size: 0.8125rem;
    text-align: left;
    transition: background 0.15s;
  }

  .group-btn:hover {
    background: var(--smrt-color-surface-variant, #e1e2ec);
  }

  .group-btn.active {
    background: var(--smrt-color-primary-container, #d8e2ff);
    color: var(--smrt-color-on-primary-container, #001a41);
    font-weight: 600;
  }

  .group-icon { font-size: 1rem; }

  .group-label { flex: 1; }

  .group-count {
    background: var(--smrt-color-surface-variant, #e1e2ec);
    padding: 0.1rem 0.4rem;
    border-radius: 999px;
    font-size: 0.7rem;
    font-weight: 600;
  }

  .group-btn.active .group-count {
    background: rgba(0,0,0,0.08);
  }

  .endpoints-panel {
    background: var(--smrt-color-surface, #fff);
    border: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
    border-radius: 1rem;
    padding: 1.5rem;
    box-shadow: 0 2px 8px rgba(0,0,0,0.04);
  }

  .endpoints-panel h2 {
    margin: 0 0 1rem 0;
    font-size: 1.25rem;
  }

  .endpoint-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .endpoint-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.5rem 0.75rem;
    border-radius: 0.5rem;
    background: var(--smrt-color-surface-container-low, #f7f7fb);
    font-size: 0.8125rem;
    flex-wrap: wrap;
  }

  .method-badge {
    display: inline-flex;
    align-items: center;
    padding: 0.15rem 0.45rem;
    border-radius: 0.25rem;
    color: white;
    font-size: 0.6875rem;
    font-weight: 700;
    font-family: monospace;
    min-width: 3rem;
    justify-content: center;
  }

  .endpoint-path {
    font-size: 0.8125rem;
    color: var(--smrt-color-on-surface, #1a1c1e);
    word-break: break-all;
  }

  .endpoint-desc {
    flex: 1;
    color: var(--smrt-color-on-surface-variant, #74777f);
    font-size: 0.75rem;
    text-align: right;
  }

  .try-btn {
    padding: 0.2rem 0.6rem;
    border: 1px solid var(--smrt-color-primary, #005ac1);
    border-radius: 0.25rem;
    background: transparent;
    color: var(--smrt-color-primary, #005ac1);
    font-size: 0.6875rem;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.15s;
  }

  .try-btn:hover {
    background: var(--smrt-color-primary, #005ac1);
    color: white;
  }

  .try-panel {
    margin-top: 1rem;
    border: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
    border-radius: 0.75rem;
    overflow: hidden;
  }

  .try-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.6rem 0.75rem;
    background: var(--smrt-color-surface-container-low, #f7f7fb);
    border-bottom: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
  }

  .try-header code {
    flex: 1;
    font-size: 0.8125rem;
  }

  .close-btn {
    border: none;
    background: none;
    cursor: pointer;
    font-size: 1rem;
    color: var(--smrt-color-on-surface-variant, #74777f);
    padding: 0.2rem 0.4rem;
    border-radius: 0.25rem;
  }

  .close-btn:hover {
    background: var(--smrt-color-surface-variant, #e1e2ec);
  }

  .try-loading {
    padding: 1rem;
    text-align: center;
    color: var(--smrt-color-on-surface-variant, #74777f);
    margin: 0;
  }

  .try-result, .try-error {
    margin: 0;
    padding: 1rem;
    font-size: 0.75rem;
    line-height: 1.5;
    max-height: 400px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .try-error {
    color: var(--smrt-color-error, #ba1a1a);
    background: var(--smrt-color-error-container, #ffdad6);
  }

  .try-result {
    background: var(--smrt-color-surface-container-lowest, #fff);
  }

  @media (max-width: 768px) {
    .explorer-layout {
      grid-template-columns: 1fr;
    }

    .group-nav {
      flex-direction: row;
      overflow-x: auto;
      flex-wrap: nowrap;
      position: static;
    }

    .group-btn {
      white-space: nowrap;
    }
  }
</style>
