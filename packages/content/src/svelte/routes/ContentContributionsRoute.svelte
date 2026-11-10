<script lang="ts">
import { Form, Input } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { onMount } from 'svelte';
import {
  type ContentContributionData,
  type ContentContributionTypeConfigStateData,
  type ContentContributionTypeData,
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
import { M } from '../i18n.routes.js';
import {
  CONTENT_DEFAULT_ROUTE_NAVIGATION,
  CONTENT_ROUTE_IDS,
  type ContentRouteNavigationItem,
} from './shared.js';

interface ContentContributionsRouteProps {
  /** Pre-initialized API client; creates a new one if omitted. */
  client?: ReturnType<typeof createClient>;
  /** Navigation items shown in the sidebar. */
  navigation?: ContentRouteNavigationItem[];
  /** Base URL for content API requests. */
  apiBaseUrl?: string;
  /** Whether the route is embedded in a parent application. */
  embedded?: boolean;
}

let {
  navigation = CONTENT_DEFAULT_ROUTE_NAVIGATION,
  apiBaseUrl = '/api/v1',
  embedded = false,
  client = undefined,
}: ContentContributionsRouteProps = $props();

const apiClient = $derived(client ?? createClient(apiBaseUrl));
const { t } = useI18n();

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
  const response = await apiClient.contentContributions.getContributionTypes();
  contributionTypes = response.data;
}

async function loadContributors() {
  const response = await apiClient.contentContributors.list();
  contributors = response.data;

  if (!portalEmail) {
    portalEmail = pickPortalEmail(response.data);
  }
}

async function loadInbox() {
  const response = await apiClient.contentContributions.listInbox();
  inboxContributions = response.data;
  selectedInboxId = response.data[0]?.id || null;
}

async function loadPortal() {
  if (!portalEmail) {
    portalContributions = [];
    selectedPortalId = null;
    return;
  }

  const response = await apiClient.contentContributions.listForContributor({
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
  } catch (err) {
    error =
      (err instanceof Error ? err.message : '') ||
      'Failed to load contribution operations.';
  } finally {
    loading = false;
  }
}

async function refreshPortalOnly() {
  refreshingPortal = true;
  error = null;

  try {
    await loadPortal();
  } catch (err) {
    error =
      (err instanceof Error ? err.message : '') ||
      'Failed to load contributor submissions.';
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
  } catch (err) {
    error = (err instanceof Error ? err.message : '') || message;
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
      const response =
        await apiClient.contentContributions.submitWebContribution({
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
    await apiClient.contentContributions.withdraw(contribution.id || '', {
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
    await apiClient.contentContributions.approve(contribution.id || '', {
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
    await apiClient.contentContributions.requestChanges(contribution.id || '', {
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
    await apiClient.contentContributions.reject(contribution.id || '', {
      editorNote: options.note,
    });
    notice = `Rejected "${contribution.title || contribution.id}".`;
  });
}

async function handleSaveType(data: Partial<ContentContributionTypeData>) {
  await runContributionAction(
    'Saving contribution type...',
    async () => {
      if (data.id) {
        await apiClient.contentContributionTypes.update(data.id, data);
      } else {
        await apiClient.contentContributionTypes.create(data);
      }
      notice = `Saved contribution type "${data.label || data.key}".`;
    },
    { refreshTypes: true },
  );
}

async function handleDeleteType(data: Partial<ContentContributionTypeData>) {
  await runContributionAction(
    'Deleting contribution type...',
    async () => {
      await apiClient.contentContributionTypes.delete(data.id || '');
      notice = `Deleted contribution type "${data.label || data.key}".`;
    },
    { refreshTypes: true },
  );
}

async function handleSaveContributor(data: Partial<ContentContributorData>) {
  await runContributionAction(
    'Saving contributor...',
    async () => {
      if (data.id) {
        await apiClient.contentContributors.update(data.id, data);
      } else {
        await apiClient.contentContributors.create(data);
      }
      portalEmail = data.email || portalEmail;
      notice = `Saved contributor "${data.name || data.email}".`;
    },
    { refreshContributors: true },
  );
}

async function handleDeleteContributor(data: Partial<ContentContributorData>) {
  await runContributionAction(
    'Deleting contributor...',
    async () => {
      await apiClient.contentContributors.delete(data.id || '');
      if (portalEmail === data.email) {
        portalEmail = '';
      }
      notice = `Deleted contributor "${data.name || data.email}".`;
    },
    { refreshContributors: true },
  );
}
</script>

<div class="smrt-content-contributions-route__root" class:smrt-content-contributions-route__page--embedded={embedded} data-smrt-component="ContentContributionsRoute">
  <header class="smrt-content-contributions-route__header" data-smrt-part="header">
    <div class="smrt-content-contributions-route__container" data-smrt-part="body">
      <div class="smrt-content-contributions-route__header-copy" data-smrt-part="copy">
        <div class="smrt-content-contributions-route__eyebrow" data-smrt-part="eyebrow">{t(M['content.contributions.eyebrow'])}</div>
        <h1>{t(M['content.contributions.heading'])}</h1>
        <p>
          {t(M['content.contributions.intro'])}
        </p>
      </div>

      <nav class="smrt-content-contributions-route__nav" data-smrt-part="nav" aria-label={t(M['content.contributions.nav_aria'])}>
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

  <main class="smrt-content-contributions-route__container smrt-content-contributions-route__main" data-smrt-part="main">
    <section class="smrt-content-contributions-route__callout" data-smrt-part="callout">
      <div class="smrt-content-contributions-route__callout-header" data-smrt-part="header">
        <div>
          <strong>{t(M['content.contributions.callout_title'])}</strong>
          <p>
            {t(M['content.contributions.callout_body'])}
          </p>
        </div>
        <span class="smrt-content-contributions-route__pill" data-smrt-part="badge">Live</span>
      </div>

      <div class="smrt-content-contributions-route__callout-chips" data-smrt-part="chips" aria-label={t(M['content.contributions.chips_aria'])}>
        <span>{t(M['content.contributions.chip_held_intake'])}</span>
        <span>{t(M['content.contributions.chip_portal_actions'])}</span>
        <span>{t(M['content.contributions.chip_inbox_decisions'])}</span>
        <span>{t(M['content.contributions.chip_type_trust'])}</span>
      </div>

      <p class="smrt-content-contributions-route__callout-note" data-smrt-part="note">
        {t(M['content.contributions.email_note_prefix'])}
        <code>/api/v1/contentcontributions/ingest-email</code> {t(M['content.contributions.email_note_suffix'])}
      </p>
    </section>

    {#if loading}
      <section class="smrt-content-contributions-route__panel" data-smrt-part="panel">
        <p>{t(M['content.contributions.loading'])}</p>
      </section>
    {:else}
      {#if error}
        <section class="smrt-content-contributions-route__panel smrt-content-contributions-route__panel--error" data-smrt-part="panel">
          <strong>Error</strong>
          <p>{error}</p>
        </section>
      {/if}

      {#if notice}
        <section class="smrt-content-contributions-route__panel smrt-content-contributions-route__panel--notice" data-smrt-part="panel">
          <strong>{t(M['content.contributions.latest_action'])}</strong>
          <p>{notice}</p>
        </section>
      {/if}

      {#if busyMessage}
        <section class="smrt-content-contributions-route__panel" data-smrt-part="panel">
          <p>{busyMessage}</p>
        </section>
      {/if}

      <div class="smrt-content-contributions-route__grid" data-smrt-part="grid">
        <section class="smrt-content-contributions-route__panel" data-smrt-part="panel">
          <div class="smrt-content-contributions-route__section-heading" data-smrt-part="header">
            <div>
              <h2>{t(M['content.contributions.submission_title'])}</h2>
              <p>
                {t(M['content.contributions.submission_body'])}
              </p>
            </div>
          </div>

          <ContentContributionForm
            types={contributionTypes?.effective || []}
            submitLabel="Submit to holding queue"
            onSubmit={handleSubmitContribution}
          />
        </section>

        <section class="smrt-content-contributions-route__panel" data-smrt-part="panel">
          <div class="smrt-content-contributions-route__section-heading" data-smrt-part="header">
            <div>
              <h2>{t(M['content.contributions.portal_title'])}</h2>
              <p>
                {t(M['content.contributions.portal_body'])}
              </p>
            </div>
            <div class="smrt-content-contributions-route__form-shell" data-smrt-part="form">
              <Form
                class="inline-form"
                onsubmit={(event) => {
                  event.preventDefault();
                  void refreshPortalOnly();
                }}
              >
                <Input
                  type="email"
                  bind:value={portalEmail}
                  placeholder={t(M['content.contributions.portal_email_placeholder'])}
                />
                <Button
                  variant="ghost"
                  type="submit"
                  class="load-button"
                  disabled={refreshingPortal}
                >
                  {refreshingPortal ? 'Loading...' : 'Load'}
                </Button>
              </Form>
            </div>
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

      <section class="smrt-content-contributions-route__panel" data-smrt-part="panel">
        <div class="smrt-content-contributions-route__section-heading" data-smrt-part="header">
          <div>
            <h2>{t(M['content.contributions.inbox_title'])}</h2>
            <p>
              {t(M['content.contributions.inbox_body'])}
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

      <div class="smrt-content-contributions-route__grid" data-smrt-part="grid">
        <section class="smrt-content-contributions-route__panel" data-smrt-part="panel">
          <div class="smrt-content-contributions-route__section-heading" data-smrt-part="header">
            <div>
              <h2>{t(M['content.contributions.types_title'])}</h2>
              <p>
                {t(M['content.contributions.types_body'])}
              </p>
            </div>
            <span class="smrt-content-contributions-route__pill" data-smrt-part="badge">{contributionTypes?.effective.length || 0}</span>
          </div>

          <ContentContributionTypeManager
            types={contributionTypes?.effective || []}
            onSave={handleSaveType}
            onDelete={handleDeleteType}
          />
        </section>

        <section class="smrt-content-contributions-route__panel" data-smrt-part="panel">
          <div class="smrt-content-contributions-route__section-heading" data-smrt-part="header">
            <div>
              <h2>{t(M['content.contributions.trust_title'])}</h2>
              <p>
                {t(M['content.contributions.trust_body'])}
              </p>
            </div>
            <span class="smrt-content-contributions-route__pill" data-smrt-part="badge">{contributors.length}</span>
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
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  :global(body:has(.smrt-content-contributions-route__root:not(.smrt-content-contributions-route__page--embedded))) {
    margin: 0;
    min-height: 100vh;
  }
  .smrt-content-contributions-route__root {
    min-height: 100vh;
    padding: 2rem 1.25rem 3rem;
  }
  .smrt-content-contributions-route__page--embedded {
    min-height: auto;
    padding: 0;
  }
  .smrt-content-contributions-route__container {
    max-width: 1400px;
    margin: 0 auto;
  }
  .smrt-content-contributions-route__header {
    margin-bottom: 1.5rem;
  }
  .smrt-content-contributions-route__header .smrt-content-contributions-route__container {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .smrt-content-contributions-route__header-copy {
    max-width: 56rem;
  }
  .smrt-content-contributions-route__header h1 {
    margin: 0.35rem 0 0.65rem;
  }
  .smrt-content-contributions-route__header p {
    margin: 0;
    max-width: 52rem;
  }
  .smrt-content-contributions-route__nav {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
    align-items: center;
  }
  .smrt-content-contributions-route__nav a {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 2.5rem;
    padding: 0 1rem;
  }
  .smrt-content-contributions-route__main {
    display: grid;
    gap: 1rem;
  }
  .smrt-content-contributions-route__callout,
  .smrt-content-contributions-route__panel {
    padding: 1.25rem;
  }
  .smrt-content-contributions-route__callout {
    display: grid;
    gap: 0.8rem;
  }
  .smrt-content-contributions-route__callout-header {
    display: flex;
    gap: 1rem;
    justify-content: space-between;
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .smrt-content-contributions-route__callout-header p,
  .smrt-content-contributions-route__callout-note {
    margin: 0;
  }
  .smrt-content-contributions-route__callout-chips {
    display: flex;
    gap: 0.6rem;
    flex-wrap: wrap;
  }
  .smrt-content-contributions-route__callout-chips span {
    display: inline-flex;
    align-items: center;
    min-height: 2rem;
    padding: 0 0.8rem;
  }
  .smrt-content-contributions-route__grid {
    display: grid;
    gap: 1rem;
  }
  .smrt-content-contributions-route__section-heading {
    display: flex;
    gap: 1rem;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 1rem;
    flex-wrap: wrap;
  }
  .smrt-content-contributions-route__section-heading h2 {
    margin: 0 0 0.25rem;
  }
  .smrt-content-contributions-route__section-heading p {
    margin: 0;
  }
  .smrt-content-contributions-route__form-shell :global(.inline-form) {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
    align-items: center;
  }
  .smrt-content-contributions-route__form-shell :global([data-smrt-component="Input"]) {
    min-width: min(22rem, 100%);
    padding: 0.7rem 0.85rem;
  }
  .smrt-content-contributions-route__form-shell :global(.load-button) {
    padding: 0.65rem 0.95rem;
    cursor: pointer;
  }
  .smrt-content-contributions-route__pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 2rem;
    min-height: 2rem;
    padding: 0 0.8rem;
  }
  @media (min-width: 1024px) {
    .smrt-content-contributions-route__grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  @media (max-width: 720px) {
    .smrt-content-contributions-route__root {
      padding: 1rem 0.85rem 2rem;
    }
    .smrt-content-contributions-route__header {
      margin-bottom: 1rem;
    }
    .smrt-content-contributions-route__header h1 {
      margin-top: 0.25rem;
    }
    .smrt-content-contributions-route__callout,
    .smrt-content-contributions-route__panel {
      padding: 1rem;
    }
    .smrt-content-contributions-route__callout-chips {
      display: none;
    }
    .smrt-content-contributions-route__callout-header {
      gap: 0.5rem;
      align-items: center;
    }
    .smrt-content-contributions-route__pill {
      min-height: 1.7rem;
      min-width: 0;
      padding: 0 0.65rem;
    }
    .smrt-content-contributions-route__section-heading {
      gap: 0.75rem;
      margin-bottom: 0.85rem;
    }
  }
}

@layer smrt.theme {
  :global(body:has(.smrt-content-contributions-route__root:not(.smrt-content-contributions-route__page--embedded))) {
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
  }
  .smrt-content-contributions-route__eyebrow {
    color: var(--smrt-color-on-surface-variant);
    text-transform: uppercase;
    letter-spacing: var(--smrt-typography-label-medium-tracking, 0.08em);
    font-size: var(--smrt-typography-label-medium-size, 0.78rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
  }
  .smrt-content-contributions-route__header h1 {
    font-size: clamp(2rem, 5vw, 3rem);
    line-height: 1.05;
  }
  .smrt-content-contributions-route__header p {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-large-size, 1rem);
  }
  .smrt-content-contributions-route__nav a {
    border-radius: var(--smrt-radius-full);
    border: var(--smrt-hairline);
    background: color-mix(
      in srgb,
      var(--smrt-color-surface) 92%,
      transparent
    );
    color: var(--smrt-color-on-surface);
    text-decoration: none;
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-content-contributions-route__nav a[aria-current='page'] {
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
  .smrt-content-contributions-route__callout,
  .smrt-content-contributions-route__panel {
    border: var(--smrt-hairline);
    background: color-mix(
      in srgb,
      var(--smrt-color-surface) 95%,
      transparent
    );
    box-shadow: var(--smrt-elevation-1, 0 8px 24px rgba(15, 23, 42, 0.05));
    border-radius: 1rem;
  }
  .smrt-content-contributions-route__panel--error {
    border-color: color-mix(in srgb, var(--smrt-color-error) 30%, transparent);
  }
  .smrt-content-contributions-route__panel--notice {
    border-color: color-mix(in srgb, var(--smrt-color-primary) 30%, transparent);
  }
  .smrt-content-contributions-route__callout-header p,
  .smrt-content-contributions-route__callout-note {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-content-contributions-route__callout-chips span {
    border-radius: var(--smrt-radius-full);
    background: color-mix(
      in srgb,
      var(--smrt-color-surface-container-low) 90%,
      transparent
    );
    color: var(--smrt-color-on-surface);
    font-size: var(--smrt-typography-label-large-size, 0.83rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-content-contributions-route__callout code {
    font-family: var(
      --smrt-font-family-mono,
      'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
      'Liberation Mono', 'Courier New', monospace
    );
    font-size: 0.9em;
  }
  .smrt-content-contributions-route__section-heading p {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-content-contributions-route__form-shell :global([data-smrt-component="Input"]) {
    border-radius: 0.75rem;
    border: var(--smrt-hairline);
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
  }
  .smrt-content-contributions-route__form-shell :global(.load-button) {
    border-radius: var(--smrt-radius-full);
    border: 1px solid color-mix(
      in srgb,
      var(--smrt-color-primary) 35%,
      transparent
    );
    background: transparent;
    color: var(--smrt-color-primary);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-content-contributions-route__pill {
    border-radius: var(--smrt-radius-full);
    background: color-mix(
      in srgb,
      var(--smrt-color-primary) 14%,
      transparent
    );
    color: var(--smrt-color-primary);
    font-weight: var(--smrt-typography-weight-bold, 700);
  }
  @media (max-width: 720px) {
    .smrt-content-contributions-route__header h1 {
      font-size: clamp(1.6rem, 9vw, 2.2rem);
    }
    .smrt-content-contributions-route__callout,
    .smrt-content-contributions-route__panel {
      border-radius: 0.85rem;
    }
    .smrt-content-contributions-route__callout-header p,
    .smrt-content-contributions-route__callout-note {
      font-size: var(--smrt-typography-body-medium-size, 0.82rem);
      line-height: var(--smrt-typography-body-medium-line-height, 1.5);
    }
    .smrt-content-contributions-route__pill {
      font-size: var(--smrt-typography-label-medium-size, 0.78rem);
    }
  }
}

</style>
