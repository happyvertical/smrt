<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import type {
  FactAuditClaimData,
  FactAuditStateData,
} from '../../mock-smrt-client';
import { createClient } from '../../mock-smrt-client';
import { normalizeApiBaseUrl } from '../api';
import { M } from '../i18n.tools.js';

const { t } = useI18n();

export interface Props {
  /** Base URL for API requests to fetch fact audit data. */
  apiBaseUrl?: string;
  /** Identifier of the content to audit for factual claims. */
  contentId: string;
  /** Fired when the fact audit state changes or is loaded. */
  onFactAuditChange?: (state: FactAuditStateData | null) => void;
}

let {
  apiBaseUrl = '/api/v1',
  contentId,
  onFactAuditChange = undefined,
}: Props = $props();

const client = $derived(createClient(normalizeApiBaseUrl(apiBaseUrl)));
const savedContentId = $derived(
  contentId && contentId !== 'new' ? contentId : null,
);

let factAudit = $state<FactAuditStateData | null>(null);
let busy = $state(false);
let error = $state<string | null>(null);
let notice = $state<string | null>(null);
let selectedClaimIds = $state<string[]>([]);
let loadedContentId = $state<string | null>(null);

const factAuditGroups = $derived({
  contradicted:
    factAudit?.claims.filter(
      (claim) => claim.supportStatus === 'contradicted',
    ) || [],
  unsupported:
    factAudit?.claims.filter(
      (claim) => claim.supportStatus === 'unsupported',
    ) || [],
  needs_review:
    factAudit?.claims.filter(
      (claim) => claim.supportStatus === 'needs_review',
    ) || [],
  supported:
    factAudit?.claims.filter((claim) => claim.supportStatus === 'supported') ||
    [],
});
const actionableWarnings = $derived(
  (factAudit?.warnings ?? []).filter(
    (warning) => !/^Asset .+ has no extracted text\.$/.test(warning.trim()),
  ),
);
const selectedClaimCount = $derived(selectedClaimIds.length);

$effect(() => {
  if (!savedContentId) {
    loadedContentId = null;
    factAudit = null;
    busy = false;
    error = null;
    notice = null;
    selectedClaimIds = [];
    onFactAuditChange?.(null);
    return;
  }

  if (savedContentId !== loadedContentId) {
    loadedContentId = savedContentId;
    factAudit = null;
    error = null;
    notice = null;
    selectedClaimIds = [];
    void loadFactAudit(savedContentId);
  }
});

export async function refresh() {
  await loadFactAudit(savedContentId);
}
function getClaimId(claim: FactAuditClaimData): string | null {
  return typeof claim.id === 'string' && claim.id.length > 0 ? claim.id : null;
}

function isClaimSelected(claim: FactAuditClaimData): boolean {
  const claimId = getClaimId(claim);
  return Boolean(claimId && selectedClaimIds.includes(claimId));
}

function toggleClaimSelection(claim: FactAuditClaimData) {
  const claimId = getClaimId(claim);
  if (!claimId) return;

  selectedClaimIds = selectedClaimIds.includes(claimId)
    ? selectedClaimIds.filter((id) => id !== claimId)
    : [...selectedClaimIds, claimId];
}

async function loadFactAudit(contentIdToLoad = savedContentId) {
  if (!contentIdToLoad) return;

  busy = true;
  error = null;

  try {
    const response = await client.contents.getFactAudit(contentIdToLoad);
    if (savedContentId !== contentIdToLoad) return;
    factAudit = response.data;
    onFactAuditChange?.(response.data);
  } catch (err) {
    if (savedContentId !== contentIdToLoad) return;
    error =
      (err instanceof Error ? err.message : '') || 'Failed to load claim audit';
  } finally {
    if (savedContentId === contentIdToLoad) {
      busy = false;
    }
  }
}

async function repairFactAudit() {
  if (!savedContentId || busy) return;

  const contentIdToRepair = savedContentId;
  busy = true;
  error = null;
  notice = null;

  try {
    const response = await client.contents.repairFactAudit(contentIdToRepair);
    if (savedContentId !== contentIdToRepair) return;
    factAudit = response.data;
    notice = `Fact audit repaired: ${response.data.counts.total} claim(s) checked.`;
    onFactAuditChange?.(response.data);
  } catch (err) {
    if (savedContentId !== contentIdToRepair) return;
    error =
      (err instanceof Error ? err.message : '') ||
      'Failed to repair fact audit';
  } finally {
    if (savedContentId === contentIdToRepair) {
      busy = false;
    }
  }
}

async function recheckFactClaims(claimIds: string[]) {
  if (!savedContentId || busy || claimIds.length === 0) return;

  const contentIdToRecheck = savedContentId;
  busy = true;
  error = null;
  notice = null;

  try {
    const response = await client.contents.recheckFactClaims(
      contentIdToRecheck,
      {
        claimFactIds: claimIds,
      },
    );
    if (savedContentId !== contentIdToRecheck) return;
    factAudit = response.data;
    notice = `Rechecked ${claimIds.length} claim${claimIds.length === 1 ? '' : 's'} against current evidence.`;
    selectedClaimIds = selectedClaimIds.filter((id) => !claimIds.includes(id));
    onFactAuditChange?.(response.data);
  } catch (err) {
    if (savedContentId !== contentIdToRecheck) return;
    error =
      (err instanceof Error ? err.message : '') ||
      'Failed to recheck claim support';
  } finally {
    if (savedContentId === contentIdToRecheck) {
      busy = false;
    }
  }
}
</script>

<div class="smrt-content-claim-audit-tool__root" data-smrt-component="ContentClaimAuditTool">
  {#if error}
    <p class="smrt-content-claim-audit-tool__error" data-smrt-part="error" role="alert" aria-live="assertive">{error}</p>
  {/if}

  {#if notice}
    <p class="smrt-content-claim-audit-tool__notice" data-smrt-part="notice" role="status" aria-live="polite">{notice}</p>
  {/if}

  {#if !savedContentId}
    <p class="smrt-content-claim-audit-tool__empty" data-smrt-part="empty">{t(M['content.claim_audit_tool.save_to_audit_claims'])}</p>
  {:else}
    <div class="smrt-content-claim-audit-tool__toolbar" data-smrt-part="toolbar">
      <div class="smrt-content-claim-audit-tool__counts" data-smrt-part="meta">
        <span><strong>{factAudit?.counts.total ?? 0}</strong> {t(M['content.claim_audit_tool.article_claims'])}</span>
        <span><strong>{factAudit?.counts.supported ?? 0}</strong> supported</span>
        <span><strong>{factAudit?.counts.unsupported ?? 0}</strong> unsupported</span>
        <span><strong>{factAudit?.counts.contradicted ?? 0}</strong> contradicted</span>
        <span><strong>{factAudit?.counts.needs_review ?? 0}</strong> review</span>
      </div>
      <Button
        variant="secondary"
        type="button"
        disabled={busy || selectedClaimCount === 0}
        onclick={() => void recheckFactClaims(selectedClaimIds)}
      >
        {busy ? 'Checking...' : `Recheck selected (${selectedClaimCount})`}
      </Button>
      <Button
        variant="secondary"
        type="button"
        disabled={busy}
        onclick={() => void repairFactAudit()}
      >
        {busy ? 'Working...' : 'Repair audit'}
      </Button>
    </div>
    <p class="smrt-content-claim-audit-tool__empty" data-smrt-part="empty">
      {t(M['content.claim_audit_tool.article_claims_help'])}
    </p>

    {#if actionableWarnings.length}
      <div class="smrt-content-claim-audit-tool__warning" data-smrt-part="warning">
        {#each actionableWarnings as warning}
          <p>{warning}</p>
        {/each}
      </div>
    {/if}

    {#if !factAudit || factAudit.counts.total === 0}
      <p class="smrt-content-claim-audit-tool__empty" data-smrt-part="empty">{t(M['content.claim_audit_tool.no_claim_audit_generated'])}</p>
    {:else}
      {#each [
        ['contradicted', 'Contradicted'],
        ['unsupported', 'Unsupported'],
        ['needs_review', 'Needs review'],
        ['supported', 'Supported']
      ] as group}
        {@const groupKey = group[0] as keyof typeof factAuditGroups}
        {@const groupClaims = factAuditGroups[groupKey]}
        {#if groupClaims.length > 0}
          <div class="smrt-content-claim-audit-tool__list" data-smrt-part="list">
            <div class="smrt-content-claim-audit-tool__caption" data-smrt-part="caption">{t(M['content.claim_audit_tool.group_article_claims'], { group: group[1] })}</div>
            {#each groupClaims as claim (claim.id ?? claim.claimQuote ?? claim.fact.textRefined)}
              <details class="smrt-content-claim-audit-tool__card" data-smrt-part="card">
                <summary>
                  <label class="smrt-content-claim-audit-tool__select" data-smrt-part="label">
                    <!-- raw-primitive-allow: native checkbox; no Provider-free checkbox primitive (Toggle is a switch with different semantics, CheckboxInput requires a Provider) -->
                    <input
                      type="checkbox"
                      checked={isClaimSelected(claim)}
                      disabled={!getClaimId(claim)}
                      onchange={() => toggleClaimSelection(claim)}
                    />
                  </label>
                  <span class={`smrt-content-claim-audit-tool__pill smrt-content-claim-audit-tool__pill--${claim.supportStatus === 'supported' ? 'passed' : claim.supportStatus === 'contradicted' ? 'failed' : 'flagged'}`} data-smrt-part="badge">
                    {claim.supportStatus.replace('_', ' ')}
                  </span>
                  <strong>{claim.fact.textRefined || claim.claimQuote || claim.id}</strong>
                </summary>
                <div class="smrt-content-claim-audit-tool__card-body" data-smrt-part="body">
                  <div class="smrt-content-claim-audit-tool__actions" data-smrt-part="actions">
                    <Button
                      variant="secondary"
                      type="button"
                      disabled={busy || !getClaimId(claim)}
                      onclick={() => {
                        const claimId = getClaimId(claim);
                        if (claimId) void recheckFactClaims([claimId]);
                      }}
                    >
                      {t(M['content.claim_audit_tool.recheck_support'])}
                    </Button>
                  </div>
                  {#if claim.claimQuote}
                    <p><strong>{t(M['content.claim_audit_tool.article_claim_label'])}</strong> {claim.claimQuote}</p>
                  {/if}
                  {#if claim.rationale}
                    <p><strong>{t(M['content.claim_audit_tool.support_assessment_label'])}</strong> {claim.rationale}</p>
                  {/if}
                  {#if claim.matchedFacts?.length}
                    <div class="smrt-content-claim-audit-tool__list" data-smrt-part="list">
                      <div class="smrt-content-claim-audit-tool__caption" data-smrt-part="caption">{t(M['content.claim_audit_tool.based_on_source_evidence'])}</div>
                      {#each claim.matchedFacts as matched (matched.fact.id ?? matched.fact.textRefined)}
                        <div class="smrt-content-claim-audit-tool__card smrt-content-claim-audit-tool__card--nested" data-smrt-part="card">
                          <strong>{t(M['content.claim_audit_tool.source_claim_label'])} {matched.fact.textRefined || matched.fact.textRaw || matched.fact.id}</strong>
                          {#each matched.evidence ?? [] as evidence (evidence.id ?? evidence.evidenceKey)}
                            <span>
                              {evidence.sourceTitle || 'Source'}
                              {#if evidence.locator}
                                · {evidence.locator}
                              {/if}
                              {#if evidence.quote}
                                · {evidence.quote}
                              {/if}
                            </span>
                          {/each}
                        </div>
                      {/each}
                    </div>
                  {:else}
                    <p><strong>{t(M['content.claim_audit_tool.based_on_label'])}</strong> {t(M['content.claim_audit_tool.no_supporting_source_evidence'])}</p>
                  {/if}
                </div>
              </details>
            {/each}
          </div>
        {/if}
      {/each}
    {/if}
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  /* The tool lays itself out by its own width, not the viewport, so it
  fits a full page, a side panel, the assistant dock or a phone. */
  .smrt-content-claim-audit-tool__root {
    container-type: inline-size;
    container-name: governance-tool;
  }
  .smrt-content-claim-audit-tool__root,
  .smrt-content-claim-audit-tool__list,
  .smrt-content-claim-audit-tool__card-body {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .smrt-content-claim-audit-tool__toolbar,
  .smrt-content-claim-audit-tool__counts {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    flex-wrap: wrap;
  }
  .smrt-content-claim-audit-tool__toolbar {
    justify-content: space-between;
  }
  .smrt-content-claim-audit-tool__card {
    padding: 0.75rem;
  }
  .smrt-content-claim-audit-tool__card.smrt-content-claim-audit-tool__card--nested {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .smrt-content-claim-audit-tool__card summary {
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
  .smrt-content-claim-audit-tool__card p,
  .smrt-content-claim-audit-tool__warning p {
    margin: 0;
  }
  .smrt-content-claim-audit-tool__card-body {
    padding-top: 0.75rem;
  }
  .smrt-content-claim-audit-tool__actions {
    display: flex;
    justify-content: flex-end;
  }
  .smrt-content-claim-audit-tool__select {
    display: inline-flex;
  }
  .smrt-content-claim-audit-tool__pill {
    padding: 0.2rem 0.55rem;
  }
  .smrt-content-claim-audit-tool__error,
  .smrt-content-claim-audit-tool__notice,
  .smrt-content-claim-audit-tool__warning {
    margin: 0;
    padding: 0.75rem 0.9rem;
  }
  .smrt-content-claim-audit-tool__select {
    min-width: 2.75rem;
    min-height: 2.75rem;
    align-items: center;
    justify-content: center;
  }
  .smrt-content-claim-audit-tool__card summary {
    min-height: 2.75rem;
  }
  @container governance-tool (max-width: 30rem) {
    .smrt-content-claim-audit-tool__toolbar {
      flex-direction: column;
      align-items: stretch;
    }
    .smrt-content-claim-audit-tool__toolbar :global(button),
    .smrt-content-claim-audit-tool__actions :global(button) {
      width: 100%;
    }
    .smrt-content-claim-audit-tool__actions {
      justify-content: stretch;
    }
    .smrt-content-claim-audit-tool__card summary {
      flex-wrap: wrap;
    }
  }
}

@layer smrt.theme {
  .smrt-content-claim-audit-tool__counts,
  .smrt-content-claim-audit-tool__empty,
  .smrt-content-claim-audit-tool__caption,
  .smrt-content-claim-audit-tool__card span {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-medium-size, 0.85rem);
  }
  .smrt-content-claim-audit-tool__card {
    border: var(--smrt-card-border, var(--smrt-hairline));
    box-shadow: var(--smrt-card-shadow, none);
    border-radius: 0.65rem;
    background: var(--smrt-card-background, var(--smrt-color-surface));
  }
  .smrt-content-claim-audit-tool__select {
    line-height: 1;
  }
  .smrt-content-claim-audit-tool__pill {
    border-radius: var(--smrt-radius-full);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
    text-transform: capitalize;
  }
  .smrt-content-claim-audit-tool__pill--passed {
    background: color-mix(in srgb, var(--smrt-color-success) 14%, transparent);
    color: var(--smrt-color-on-success-container);
  }
  .smrt-content-claim-audit-tool__pill--flagged {
    background: color-mix(in srgb, var(--smrt-color-warning) 16%, transparent);
    color: var(--smrt-color-on-warning-container);
  }
  .smrt-content-claim-audit-tool__pill--failed {
    background: color-mix(in srgb, var(--smrt-color-error) 14%, transparent);
    color: var(--smrt-color-on-error-container);
  }
  .smrt-content-claim-audit-tool__error,
  .smrt-content-claim-audit-tool__notice,
  .smrt-content-claim-audit-tool__warning {
    border-radius: 0.6rem;
    font-size: var(--smrt-typography-body-medium-size, 0.9rem);
  }
  .smrt-content-claim-audit-tool__error {
    background: color-mix(in srgb, var(--smrt-color-error) 10%, transparent);
    color: var(--smrt-color-on-error-container);
  }
  .smrt-content-claim-audit-tool__notice {
    background: color-mix(in srgb, var(--smrt-color-primary) 10%, transparent);
    color: var(--smrt-color-on-primary-container);
  }
  .smrt-content-claim-audit-tool__warning {
    background: color-mix(in srgb, var(--smrt-color-warning) 12%, transparent);
    color: var(--smrt-color-on-warning-container);
  }
  .smrt-content-claim-audit-tool__card.smrt-content-claim-audit-tool__card--nested {
    background: color-mix(in srgb, var(--smrt-color-on-surface) 6%, transparent);
  }
}

</style>
