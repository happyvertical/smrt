<script lang="ts">
import { onMount } from 'svelte';
import {
  type ContentContributionData,
  type ContentContributionTypeConfigStateData,
  type ContentContributorData,
  createClient,
} from '../../mock-smrt-client.js';
import ContentContributionForm, {
  type ContentContributionFormSubmitData,
} from '../components/ContentContributionForm.svelte';
import ContentContributionInbox from '../components/ContentContributionInbox.svelte';
import ContentContributionPortal from '../components/ContentContributionPortal.svelte';
import ContentContributionTypeManager from '../components/ContentContributionTypeManager.svelte';
import ContentContributorManager from '../components/ContentContributorManager.svelte';
import {
  CONTENT_DEFAULT_ROUTE_NAVIGATION,
  CONTENT_ROUTE_IDS,
  type ContentRouteNavigationItem,
} from './shared.js';

interface ContentContributionsRouteProps {
  navigation?: ContentRouteNavigationItem[];
  apiBaseUrl?: string;
  embedded?: boolean;
}

let {
  navigation = CONTENT_DEFAULT_ROUTE_NAVIGATION,
  apiBaseUrl = '/api/v1',
  embedded = false,
}: ContentContributionsRouteProps = $props();

const client = $derived(createClient(apiBaseUrl));

let contributionTypes = $state<ContentContributionTypeConfigStateData | null>(
  null,
);
let contributors = $state<ContentContributorData[]>([]);
let inboxContributions = $state<ContentContributionData[]>([]);
let portalContributions = $state<ContentContributionData[]>([]);
let selectedInboxId = $state<string | null>(null);
let selectedPortalId = $state<string | null>(null);
let portalEmail = $state('');
let loading = $state(true);
let refreshingPortal = $state(false);
let busyMessage = $state<string | null>(null);
let error = $state<string | null>(null);
let notice = $state<string | null>(null);

onMount(async () => {
  await refreshContributionOperations();
});

function pickPortalEmail(nextContributors: ContentContributorData[]) {
  return (
    portalEmail ||
    nextContributors.find((item) => Boolean(item.email))?.email ||
    ''
  );
}

function mapFilesToAttachments(files: File[]) {
  return files.map((file) => ({
    filename: file.name,
    mimeType: file.type || 'application/octet-stream',
    size: file.size || 0,
    metadata: {
      source: 'content-route',
      sourceType: 'browser',
    },
  }));
}

async function loadContributionTypes() {
  const response = await client.contentContributions.getContributionTypes();
  contributionTypes = response.data;
}

async function loadContributors() {
  const response = await client.contentContributors.list();
  contributors = response.data;

  if (!portalEmail) {
    portalEmail = pickPortalEmail(response.data);
  }
}

async function loadInbox() {
  const response = await client.contentContributions.listInbox();
  inboxContributions = response.data;
  selectedInboxId = response.data[0]?.id || null;
}

async function loadPortal() {
  if (!portalEmail) {
    portalContributions = [];
    selectedPortalId = null;
    return;
  }

  const response = await client.contentContributions.listForContributor({
    contributorEmail: portalEmail,
  });
  portalContributions = response.data;
  selectedPortalId = response.data[0]?.id || null;
}

async function refreshContributionOperations() {
  loading = true;
  error = null;

  try {
    await Promise.all([
      loadContributionTypes(),
      loadContributors(),
      loadInbox(),
    ]);
    await loadPortal();
  } catch (err: any) {
    error = err.message || 'Failed to load contribution operations.';
  } finally {
    loading = false;
  }
}

async function refreshPortalOnly() {
  refreshingPortal = true;
  error = null;

  try {
    await loadPortal();
  } catch (err: any) {
    error = err.message || 'Failed to load contributor submissions.';
  } finally {
    refreshingPortal = false;
  }
}

async function runContributionAction(
  message: string,
  action: () => Promise<void>,
  options: { refreshTypes?: boolean; refreshContributors?: boolean } = {},
) {
  busyMessage = message;
  error = null;

  try {
    await action();
    if (options.refreshTypes) {
      await loadContributionTypes();
    }
    if (options.refreshContributors) {
      await loadContributors();
    }
    await loadInbox();
    await loadPortal();
  } catch (err: any) {
    error = err.message || message;
  } finally {
    busyMessage = null;
  }
}

async function handleSubmitContribution(
  payload: ContentContributionFormSubmitData,
) {
  await runContributionAction(
    'Submitting contribution...',
    async () => {
      const response = await client.contentContributions.submitWebContribution({
        typeKey: payload.typeKey,
        contributorEmail: payload.contributorEmail,
        contributorName: payload.contributorName,
        title: payload.title || null,
        description: payload.description || null,
        body: payload.body || null,
        attachments: mapFilesToAttachments(payload.files),
        metadata: {
          source: 'content-route',
        },
      });

      portalEmail = payload.contributorEmail || portalEmail;
      const contribution =
        response.data?.contribution ||
        response.data?.data?.contribution ||
        response.data;
      selectedPortalId = contribution?.id || null;
      notice = `Submitted "${payload.title || payload.typeKey}" for ${portalEmail}.`;
    },
    { refreshContributors: true },
  );
}

async function handleWithdraw(contribution: ContentContributionData) {
  await runContributionAction('Withdrawing contribution...', async () => {
    await client.contentContributions.withdraw(contribution.id || '', {
      reason: 'Withdrawn from the contribution route.',
    });
    notice = `Withdrew "${contribution.title || contribution.id}".`;
  });
}

async function handleApprove(
  contribution: ContentContributionData,
  options: { targetStatus: 'draft' | 'review'; note: string },
) {
  await runContributionAction('Approving contribution...', async () => {
    await client.contentContributions.approve(contribution.id || '', {
      editorNote: options.note,
      targetStatus: options.targetStatus,
    });
    notice = `Approved "${contribution.title || contribution.id}" into ${options.targetStatus}.`;
  });
}

async function handleRequestChanges(
  contribution: ContentContributionData,
  options: { note: string },
) {
  await runContributionAction('Requesting changes...', async () => {
    await client.contentContributions.requestChanges(contribution.id || '', {
      editorNote: options.note,
    });
    notice = `Requested changes for "${contribution.title || contribution.id}".`;
  });
}

async function handleReject(
  contribution: ContentContributionData,
  options: { note: string },
) {
  await runContributionAction('Rejecting contribution...', async () => {
    await client.contentContributions.reject(contribution.id || '', {
      editorNote: options.note,
    });
    notice = `Rejected "${contribution.title || contribution.id}".`;
  });
}

async function handleSaveType(data: Record<string, any>) {
  await runContributionAction(
    'Saving contribution type...',
    async () => {
      if (data.id) {
        await client.contentContributionTypes.update(data.id, data);
      } else {
        await client.contentContributionTypes.create(data);
      }
      notice = `Saved contribution type "${data.label || data.key}".`;
    },
    { refreshTypes: true },
  );
}

async function handleDeleteType(data: Record<string, any>) {
  await runContributionAction(
    'Deleting contribution type...',
    async () => {
      await client.contentContributionTypes.delete(data.id || '');
      notice = `Deleted contribution type "${data.label || data.key}".`;
    },
    { refreshTypes: true },
  );
}

async function handleSaveContributor(data: Record<string, any>) {
  await runContributionAction(
    'Saving contributor...',
    async () => {
      if (data.id) {
        await client.contentContributors.update(data.id, data);
      } else {
        await client.contentContributors.create(data);
      }
      portalEmail = data.email || portalEmail;
      notice = `Saved contributor "${data.name || data.email}".`;
    },
    { refreshContributors: true },
  );
}

async function handleDeleteContributor(data: Record<string, any>) {
  await runContributionAction(
    'Deleting contributor...',
    async () => {
      await client.contentContributors.delete(data.id || '');
      if (portalEmail === data.email) {
        portalEmail = '';
      }
      notice = `Deleted contributor "${data.name || data.email}".`;
    },
    { refreshContributors: true },
  );
}
</script>

<div class:page={true} class:page--embedded={embedded}>
  <header class="page-header">
    <div class="container">
      <div class="page-header__copy">
        <div class="eyebrow">Content contributions</div>
        <h1>Contribution operations</h1>
        <p>
          Manage public intake, contributor records, moderation decisions, and
          promotion into draft or review-ready content.
        </p>
      </div>

      <nav class="page-nav" aria-label="Content navigation">
        {#each navigation as item (item.routeId)}
          <a
            href={item.href}
            aria-current={item.routeId === CONTENT_ROUTE_IDS.contributions
              ? 'page'
              : undefined}
          >
            {item.label}
          </a>
        {/each}
      </nav>
    </div>
  </header>

  <main class="container page-main">
    <section class="callout">
      <div class="callout__header">
        <div>
          <strong>Live contribution stack</strong>
          <p>
            Intake, moderation, and contributor controls against the generated
            content APIs.
          </p>
        </div>
        <span class="pill">Live</span>
      </div>

      <div class="callout__chips" aria-label="Workspace scope">
        <span>Held web intake</span>
        <span>Contributor portal actions</span>
        <span>Editorial inbox decisions</span>
        <span>Type and trust overrides</span>
      </div>

      <p class="callout__note">
        Email ingestion remains available at
        <code>/api/v1/contentcontributions/ingest-email</code> when message
        records exist.
      </p>
    </section>

    {#if loading}
      <section class="panel">
        <p>Loading contribution operations...</p>
      </section>
    {:else}
      {#if error}
        <section class="panel panel--error">
          <strong>Error</strong>
          <p>{error}</p>
        </section>
      {/if}

      {#if notice}
        <section class="panel panel--notice">
          <strong>Latest action</strong>
          <p>{notice}</p>
        </section>
      {/if}

      {#if busyMessage}
        <section class="panel">
          <p>{busyMessage}</p>
        </section>
      {/if}

      <div class="qa-grid">
        <section class="panel">
          <div class="section-heading">
            <div>
              <h2>Contributor submission</h2>
              <p>
                Submit a held contribution through the same generated action
                your app would call.
              </p>
            </div>
          </div>

          <ContentContributionForm
            types={contributionTypes?.effective || []}
            submitLabel="Submit to holding queue"
            onSubmit={handleSubmitContribution}
          />
        </section>

        <section class="panel">
          <div class="section-heading">
            <div>
              <h2>Contributor portal</h2>
              <p>
                Load a contributor by email to inspect their submissions and
                withdraw eligible items.
              </p>
            </div>
            <form
              class="inline-form"
              onsubmit={(event) => {
                event.preventDefault();
                void refreshPortalOnly();
              }}
            >
              <input
                type="email"
                bind:value={portalEmail}
                placeholder="contributor@example.com"
              />
              <button
                type="submit"
                class="secondary"
                disabled={refreshingPortal}
              >
                {refreshingPortal ? 'Loading...' : 'Load'}
              </button>
            </form>
          </div>

          <ContentContributionPortal
            contributions={portalContributions}
            selectedId={selectedPortalId}
            emptyMessage="No submissions found for that contributor yet."
            onSelect={(contribution) => {
              selectedPortalId = contribution.id || null;
            }}
            onWithdraw={handleWithdraw}
          />
        </section>
      </div>

      <section class="panel">
        <div class="section-heading">
          <div>
            <h2>Editorial inbox</h2>
            <p>
              Review held or quarantined submissions and promote them into
              draft or review content.
            </p>
          </div>
        </div>

        <ContentContributionInbox
          contributions={inboxContributions}
          selectedId={selectedInboxId}
          onSelect={(contribution) => {
            selectedInboxId = contribution.id || null;
          }}
          onApprove={handleApprove}
          onRequestChanges={handleRequestChanges}
          onReject={handleReject}
        />
      </section>

      <div class="qa-grid">
        <section class="panel">
          <div class="section-heading">
            <div>
              <h2>Contribution types</h2>
              <p>
                Adjust intake rules, allowed channels, and promotion behavior.
              </p>
            </div>
            <span class="pill">{contributionTypes?.effective.length || 0}</span>
          </div>

          <ContentContributionTypeManager
            types={contributionTypes?.effective || []}
            onSave={handleSaveType}
            onDelete={handleDeleteType}
          />
        </section>

        <section class="panel">
          <div class="section-heading">
            <div>
              <h2>Contributor trust</h2>
              <p>
                Set contributor trust levels for moderation and auto-promotion
                paths.
              </p>
            </div>
            <span class="pill">{contributors.length}</span>
          </div>

          <ContentContributorManager
            contributors={contributors}
            onSave={handleSaveContributor}
            onDelete={handleDeleteContributor}
          />
        </section>
      </div>
    {/if}
  </main>
</div>

<style>
  :global(body) {
    margin: 0;
    font-family:
      var(--smrt-font-family, 'Inter', -apple-system, BlinkMacSystemFont,
      'Segoe UI', Roboto, sans-serif);
    background:
      radial-gradient(
        circle at top,
        color-mix(in srgb, var(--smrt-color-primary) 10%, transparent),
        transparent 36%
      ),
      var(--smrt-color-background);
    color: var(--smrt-color-on-background);
    min-height: 100vh;
  }

  .page {
    min-height: 100vh;
    padding: 2rem 1.25rem 3rem;
  }

  .page--embedded {
    min-height: auto;
    padding: 0;
  }

  .container {
    max-width: 1400px;
    margin: 0 auto;
  }

  .page-header {
    margin-bottom: 1.5rem;
  }

  .page-header .container {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .page-header__copy {
    max-width: 56rem;
  }

  .eyebrow {
    color: var(--smrt-color-on-surface-variant);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 0.78rem;
    font-weight: 700;
  }

  .page-header h1 {
    margin: 0.35rem 0 0.65rem;
    font-size: clamp(2rem, 5vw, 3rem);
    line-height: 1.05;
  }

  .page-header p {
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
    font-size: 1rem;
    max-width: 52rem;
  }

  .page-nav {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
    align-items: center;
  }

  .page-nav a {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 2.5rem;
    padding: 0 1rem;
    border-radius: 999px;
    border: 1px solid var(--smrt-color-outline-variant);
    background: color-mix(
      in srgb,
      var(--smrt-color-surface) 92%,
      transparent
    );
    color: var(--smrt-color-on-surface);
    text-decoration: none;
    font-weight: 600;
  }

  .page-nav a[aria-current='page'] {
    color: var(--smrt-color-primary);
    border-color: color-mix(
      in srgb,
      var(--smrt-color-primary) 28%,
      transparent
    );
    background: color-mix(
      in srgb,
      var(--smrt-color-primary) 10%,
      var(--smrt-color-surface)
    );
  }

  .page-main {
    display: grid;
    gap: 1rem;
  }

  .callout,
  .panel {
    border: 1px solid var(--smrt-color-outline-variant);
    background: color-mix(
      in srgb,
      var(--smrt-color-surface) 95%,
      transparent
    );
    box-shadow: var(--smrt-elevation-1, 0 8px 24px rgba(15, 23, 42, 0.05));
    border-radius: 1rem;
    padding: 1.25rem;
  }

  .panel--error {
    border-color: color-mix(in srgb, var(--smrt-color-error) 30%, transparent);
  }

  .panel--notice {
    border-color: color-mix(in srgb, var(--smrt-color-primary) 30%, transparent);
  }

  .callout {
    display: grid;
    gap: 0.8rem;
  }

  .callout__header {
    display: flex;
    gap: 1rem;
    justify-content: space-between;
    align-items: flex-start;
    flex-wrap: wrap;
  }

  .callout__header p,
  .callout__note {
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
  }

  .callout__chips {
    display: flex;
    gap: 0.6rem;
    flex-wrap: wrap;
  }

  .callout__chips span {
    display: inline-flex;
    align-items: center;
    min-height: 2rem;
    padding: 0 0.8rem;
    border-radius: 999px;
    background: color-mix(
      in srgb,
      var(--smrt-color-surface-container-low) 90%,
      transparent
    );
    color: var(--smrt-color-on-surface);
    font-size: 0.83rem;
    font-weight: 600;
  }

  .callout code {
    font-family:
      'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
      'Liberation Mono', 'Courier New', monospace;
    font-size: 0.9em;
  }

  .qa-grid {
    display: grid;
    gap: 1rem;
  }

  .section-heading {
    display: flex;
    gap: 1rem;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 1rem;
    flex-wrap: wrap;
  }

  .section-heading h2 {
    margin: 0 0 0.25rem;
  }

  .section-heading p {
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
  }

  .inline-form {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    align-items: center;
  }

  .inline-form input {
    min-width: min(22rem, 100%);
    padding: 0.7rem 0.85rem;
    border-radius: 0.75rem;
    border: 1px solid var(--smrt-color-outline-variant);
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
  }

  .inline-form button,
  .secondary {
    border-radius: 999px;
    border: 1px solid color-mix(
      in srgb,
      var(--smrt-color-primary) 35%,
      transparent
    );
    background: transparent;
    color: var(--smrt-color-primary);
    font-weight: 600;
    padding: 0.65rem 0.95rem;
    cursor: pointer;
  }

  .pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 2rem;
    min-height: 2rem;
    border-radius: 999px;
    background: color-mix(
      in srgb,
      var(--smrt-color-primary) 14%,
      transparent
    );
    color: var(--smrt-color-primary);
    font-weight: 700;
    padding: 0 0.8rem;
  }

  @media (min-width: 1024px) {
    .qa-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 720px) {
    .page {
      padding: 1rem 0.85rem 2rem;
    }

    .page-header {
      margin-bottom: 1rem;
    }

    .page-header h1 {
      margin-top: 0.25rem;
      font-size: clamp(1.6rem, 9vw, 2.2rem);
    }

    .callout,
    .panel {
      padding: 1rem;
      border-radius: 0.85rem;
    }

    .callout__chips {
      display: none;
    }

    .callout__header {
      gap: 0.5rem;
      align-items: center;
    }

    .callout__header p,
    .callout__note {
      font-size: 0.82rem;
      line-height: 1.5;
    }

    .pill {
      min-height: 1.7rem;
      min-width: 0;
      padding: 0 0.65rem;
      font-size: 0.78rem;
    }

    .section-heading {
      gap: 0.75rem;
      margin-bottom: 0.85rem;
    }
  }
</style>
