<script lang="ts">
import {
  type ContentCorrectionData,
  type ContentReviewData,
  type ContentReviewProfileData,
  type ContentVersionData,
  createClient,
  type FactData,
} from '../../mock-smrt-client';

const client = createClient('/api/v1');

export interface Props {
  contentId?: string;
  selectedFactIds?: string[];
  selectedFacts?: FactData[];
  defaultRelationship?: string;
  reviewProfileKey?: string;
  customReviewLabel?: string;
  customReviewInstructions?: string;
  customReviewPolicyKey?: string;
  onFactsChange?: (factIds: string[], facts: FactData[]) => void;
}

type ReviewKind = 'facts' | 'safety' | 'custom';

interface ReviewAction {
  kind: ReviewKind;
  label: string;
  policyKey?: string;
  instructions?: string;
}

let {
  contentId = 'new',
  selectedFactIds = [],
  selectedFacts = [],
  defaultRelationship = 'supports',
  reviewProfileKey = 'publication',
  customReviewLabel = 'Custom Review',
  customReviewInstructions = '',
  customReviewPolicyKey = 'custom',
  onFactsChange = undefined,
} = $props<Props>();

let factQuery = $state('');
let catalogFacts = $state<FactData[]>([]);
let reviews = $state<ContentReviewData[]>([]);
let corrections = $state<ContentCorrectionData[]>([]);
let versions = $state<ContentVersionData[]>([]);
let reviewProfiles = $state<ContentReviewProfileData[]>([]);
let activeReviewProfileKey = $state(reviewProfileKey);

let catalogLoading = $state(false);
let syncingFacts = $state(false);
let workflowLoading = $state(false);
let reviewBusy = $state<string | null>(null);
let correctionBusy = $state(false);
let versionBusy = $state(false);

let catalogError = $state<string | null>(null);
let workflowError = $state<string | null>(null);
let workflowNotice = $state<string | null>(null);
let catalogLoaded = $state(false);
let loadedContentId = $state<string | null>(null);

let correctionSummary = $state('');
let correctionFactId = $state('');
let correctedFactText = $state('');
let correctionPublicNote = $state('');
let publishCorrection = $state(true);
let customReviewText = $state('');

const savedContentId = $derived(
  contentId && contentId !== 'new' ? contentId : null,
);

function getFactId(fact: FactData): string | null {
  return typeof fact.id === 'string' && fact.id.length > 0 ? fact.id : null;
}

function createFactMap(facts: FactData[]) {
  return new Map(
    facts
      .map((fact) => {
        const factId = getFactId(fact);
        return factId ? [factId, fact] : null;
      })
      .filter((entry): entry is [string, FactData] => entry !== null),
  );
}

const selectedFactsMap = $derived(createFactMap(selectedFacts));
const selectedFactsResolved = $derived(
  selectedFactIds
    .map((factId) => selectedFactsMap.get(factId))
    .filter((fact): fact is FactData => Boolean(fact)),
);
const activeReviewProfile = $derived(
  reviewProfiles.find(
    (profile) => profile.profileKey === activeReviewProfileKey,
  ) ?? null,
);
const activeProfileReviewActions = $derived(
  getReviewActions(activeReviewProfile),
);

$effect(() => {
  customReviewText = customReviewInstructions;
});

$effect(() => {
  activeReviewProfileKey = reviewProfileKey;
});

$effect(() => {
  if (!catalogLoaded) {
    catalogLoaded = true;
    void searchFacts();
  }
});

$effect(() => {
  if (!savedContentId) {
    loadedContentId = null;
    reviews = [];
    corrections = [];
    versions = [];
    reviewProfiles = [];
    workflowError = null;
    workflowNotice = null;
    return;
  }

  if (savedContentId !== loadedContentId) {
    loadedContentId = savedContentId;
    void loadSavedWorkflow();
  }
});

$effect(() => {
  if (selectedFactIds.length === 0) {
    correctionFactId = '';
    return;
  }

  if (!correctionFactId || !selectedFactIds.includes(correctionFactId)) {
    correctionFactId = selectedFactIds[0];
  }
});

function updateSelectedFacts(nextFacts: FactData[]) {
  const deduped = [
    ...new Map(
      nextFacts
        .map((fact) => {
          const factId = getFactId(fact);
          return factId ? [factId, fact] : null;
        })
        .filter((entry): entry is [string, FactData] => entry !== null),
    ).values(),
  ];

  onFactsChange?.(
    deduped
      .map((fact) => getFactId(fact))
      .filter((factId): factId is string => Boolean(factId)),
    deduped,
  );
}

function formatProfileLabel(profileKey: string) {
  return profileKey
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function resolveActiveReviewProfileKey(
  profiles: ContentReviewProfileData[],
  preferredKey: string | null | undefined,
  fallbackKey: string,
) {
  if (
    preferredKey &&
    profiles.some((profile) => profile.profileKey === preferredKey)
  ) {
    return preferredKey;
  }

  if (
    fallbackKey &&
    profiles.some((profile) => profile.profileKey === fallbackKey)
  ) {
    return fallbackKey;
  }

  return profiles[0]?.profileKey ?? fallbackKey;
}

function createReviewAction(
  kind: ReviewKind,
  policyKey: string,
  label: string,
  instructions?: string,
): ReviewAction {
  return {
    kind,
    label,
    policyKey,
    instructions,
  };
}

function normalizeReviewKind(kind: string | null | undefined): ReviewKind {
  switch (kind) {
    case 'facts':
    case 'safety':
    case 'custom':
      return kind;
    default:
      return 'custom';
  }
}

function getReviewActions(
  profile: ContentReviewProfileData | null,
): ReviewAction[] {
  const requirements = profile?.requirements ?? [];
  if (requirements.length === 0) {
    return [
      createReviewAction('facts', 'facts', 'Facts Review'),
      createReviewAction('safety', 'safety', 'Safety Review'),
    ];
  }

  const seen = new Set<string>();
  return requirements.flatMap((requirement) => {
    if (seen.has(requirement.policyKey)) {
      return [];
    }

    seen.add(requirement.policyKey);
    return [
      createReviewAction(
        normalizeReviewKind(requirement.kind),
        requirement.policyKey,
        requirement.label || formatProfileLabel(requirement.policyKey),
      ),
    ];
  });
}

function getReviewActionBusyKey(action: ReviewAction) {
  return action.policyKey || action.kind;
}

async function searchFacts(query = factQuery) {
  catalogLoading = true;
  catalogError = null;

  try {
    const response = await client.contents.browseFacts(query, {
      limit: 12,
      latestOnly: true,
    });
    catalogFacts = response.data;
  } catch (err: any) {
    catalogError = err.message || 'Failed to browse facts';
  } finally {
    catalogLoading = false;
  }
}

async function syncFactsIfSaved(nextFacts: FactData[]) {
  updateSelectedFacts(nextFacts);

  if (!savedContentId) {
    return;
  }

  syncingFacts = true;
  workflowError = null;

  try {
    const response = await client.contents.syncFacts(savedContentId, {
      factIds: nextFacts
        .map((fact) => getFactId(fact))
        .filter((factId): factId is string => Boolean(factId)),
      relationship: defaultRelationship,
    });
    updateSelectedFacts(response.data.facts || nextFacts);
    await refreshReviewProfiles();
    workflowNotice = 'Saved fact associations.';
  } catch (err: any) {
    workflowError = err.message || 'Failed to sync facts';
  } finally {
    syncingFacts = false;
  }
}

function addFact(fact: FactData) {
  const factId = getFactId(fact);
  if (!factId || selectedFactIds.includes(factId)) {
    return;
  }

  void syncFactsIfSaved([...selectedFactsResolved, fact]);
}

function removeFact(factId: string) {
  void syncFactsIfSaved(
    selectedFactsResolved.filter((fact) => getFactId(fact) !== factId),
  );
}

async function loadSavedWorkflow() {
  if (!savedContentId) {
    return;
  }

  workflowLoading = true;
  workflowError = null;

  try {
    const [
      factsResponse,
      reviewsResponse,
      correctionsResponse,
      versionsResponse,
      reviewProfilesResponse,
    ] = await Promise.all([
      client.contents.getFacts(savedContentId),
      client.contents.getReviews(savedContentId),
      client.contents.getCorrections(savedContentId),
      client.contents.getVersions(savedContentId),
      client.contents.getReviewProfiles(savedContentId),
    ]);

    updateSelectedFacts(factsResponse.data.facts || []);
    reviews = reviewsResponse.data;
    corrections = correctionsResponse.data;
    versions = versionsResponse.data;
    reviewProfiles = reviewProfilesResponse.data;
    activeReviewProfileKey = resolveActiveReviewProfileKey(
      reviewProfilesResponse.data,
      activeReviewProfileKey,
      reviewProfileKey,
    );
  } catch (err: any) {
    workflowError = err.message || 'Failed to load factual workflow state';
  } finally {
    workflowLoading = false;
  }
}

async function runReview(action: ReviewAction) {
  if (!savedContentId) {
    return;
  }

  reviewBusy = getReviewActionBusyKey(action);
  workflowError = null;
  workflowNotice = null;

  try {
    const payload: Record<string, any> = {
      kind: action.kind,
      factIds: selectedFactIds,
    };

    if (action.policyKey) {
      payload.policyKey = action.policyKey;
    }

    if (action.kind === 'custom') {
      payload.policyKey = action.policyKey || customReviewPolicyKey;
      payload.instructions = action.instructions ?? customReviewText;
    }

    const response = await client.contents.runReview(savedContentId, payload);
    reviews = [response.data, ...reviews];
    await refreshReviewProfiles();
    workflowNotice = `${action.label} completed.`;
    await refreshVersions();
  } catch (err: any) {
    workflowError = err.message || 'Failed to run content review';
  } finally {
    reviewBusy = null;
  }
}

async function issueCorrection() {
  if (!savedContentId) {
    return;
  }

  correctionBusy = true;
  workflowError = null;
  workflowNotice = null;

  try {
    await client.contents.issueCorrection(savedContentId, {
      summary: correctionSummary,
      factId: correctionFactId || undefined,
      correctedFactText: correctedFactText || undefined,
      publicNote: correctionPublicNote || undefined,
      publish: publishCorrection,
    });

    correctionSummary = '';
    correctedFactText = '';
    correctionPublicNote = '';
    publishCorrection = true;

    workflowNotice = 'Correction issued.';
    await loadSavedWorkflow();
  } catch (err: any) {
    workflowError = err.message || 'Failed to issue correction';
  } finally {
    correctionBusy = false;
  }
}

async function createSnapshot() {
  if (!savedContentId) {
    return;
  }

  versionBusy = true;
  workflowError = null;
  workflowNotice = null;

  try {
    await client.contents.createVersion(savedContentId, {
      kind: 'manual',
      summary: 'Manual editorial snapshot',
    });
    workflowNotice = 'Snapshot created.';
    await refreshVersions();
  } catch (err: any) {
    workflowError = err.message || 'Failed to create version snapshot';
  } finally {
    versionBusy = false;
  }
}

async function restoreVersion(versionNumber: number) {
  if (!savedContentId) {
    return;
  }

  if (!confirm(`Restore content version ${versionNumber}?`)) {
    return;
  }

  versionBusy = true;
  workflowError = null;
  workflowNotice = null;

  try {
    const response = await client.contents.restoreVersion(
      savedContentId,
      versionNumber,
    );
    updateSelectedFacts(response.data.facts || []);
    workflowNotice = `Restored version ${versionNumber}.`;
    await loadSavedWorkflow();
  } catch (err: any) {
    workflowError = err.message || 'Failed to restore version';
  } finally {
    versionBusy = false;
  }
}

async function refreshVersions() {
  if (!savedContentId) {
    return;
  }

  const response = await client.contents.getVersions(savedContentId);
  versions = response.data;
}

async function refreshReviewProfiles() {
  if (!savedContentId) {
    reviewProfiles = [];
    return;
  }

  const response = await client.contents.getReviewProfiles(savedContentId);
  reviewProfiles = response.data;
  activeReviewProfileKey = resolveActiveReviewProfileKey(
    response.data,
    activeReviewProfileKey,
    reviewProfileKey,
  );
}

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return 'n/a';
  }

  return `${Math.round(value * 100)}%`;
}

function formatTimestamp(value: string | null | undefined) {
  if (!value) {
    return 'Not published';
  }

  return new Date(value).toLocaleString();
}

function hasCustomReview() {
  return customReviewText.trim().length > 0;
}
</script>

<div class="factual-workflow">
  <div class="workflow-section">
    <div class="workflow-section__header">
      <h4>Facts</h4>
      {#if syncingFacts}
        <span class="section-status">Saving links...</span>
      {/if}
    </div>

    <div class="fact-search">
      <input
        type="text"
        bind:value={factQuery}
        placeholder="Browse app facts before authoring"
      />
      <button type="button" onclick={() => void searchFacts()}>
        Search
      </button>
    </div>

    {#if catalogError}
      <p class="workflow-error">{catalogError}</p>
    {/if}

    <div class="selected-facts">
      <div class="section-caption">Selected facts</div>
      {#if selectedFactsResolved.length === 0}
        <p class="empty-copy">No facts linked yet.</p>
      {:else}
        <div class="fact-chip-list">
          {#each selectedFactsResolved as fact (fact.id ?? fact.textRefined)}
            <div class="fact-chip">
              <div class="fact-chip__body">
                <strong>{fact.textRefined}</strong>
                <span>
                  {fact.status} · confidence {formatPercent(fact.confidence)}
                </span>
              </div>
              <button
                type="button"
                class="fact-chip__remove"
                onclick={() => fact.id && removeFact(fact.id)}
              >
                Remove
              </button>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <div class="fact-catalog">
      <div class="section-caption">Fact catalog</div>
      {#if catalogLoading}
        <p class="empty-copy">Loading facts...</p>
      {:else if catalogFacts.length === 0}
        <p class="empty-copy">No facts matched this search.</p>
      {:else}
        <div class="fact-catalog__list">
          {#each catalogFacts as fact (fact.id ?? fact.textRefined)}
            <div class="fact-result">
              <div class="fact-result__body">
                <strong>{fact.textRefined}</strong>
                <span>
                  {fact.status} · {fact.domain || 'general'} · confidence {formatPercent(fact.confidence)}
                </span>
              </div>
              <button
                type="button"
                disabled={!fact.id || selectedFactIds.includes(fact.id ?? '')}
                onclick={() => addFact(fact)}
              >
                {!fact.id || selectedFactIds.includes(fact.id ?? '') ? 'Selected' : 'Add'}
              </button>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>

  <div class="workflow-section">
    <div class="workflow-section__header">
      <h4>Review</h4>
      {#if workflowLoading}
        <span class="section-status">Loading...</span>
      {/if}
    </div>

    {#if workflowError}
      <p class="workflow-error">{workflowError}</p>
    {/if}

    {#if workflowNotice}
      <p class="workflow-notice">{workflowNotice}</p>
    {/if}

    {#if !savedContentId}
      <p class="empty-copy">
        Save this content to run fact reviews, safety reviews, corrections, and version management.
      </p>
    {:else}
      {#if reviewProfiles.length > 0}
        <label class="workflow-field">
          Review profile
          <select bind:value={activeReviewProfileKey}>
            {#each reviewProfiles as profile (profile.profileKey)}
              <option value={profile.profileKey}>
                {formatProfileLabel(profile.profileKey)}
              </option>
            {/each}
          </select>
        </label>
      {/if}

      {#if activeReviewProfile}
        <div class="review-profile-card">
          <div class="review-profile-card__header">
            <strong>{formatProfileLabel(activeReviewProfile.profileKey)}</strong>
            <div class="review-profile-card__badges">
              <span class={`pill ${activeReviewProfile.ready ? 'pill--passed' : 'pill--failed'}`}>
                {activeReviewProfile.ready ? 'Blocking-ready' : 'Blocking issues'}
              </span>
              <span class={`pill ${activeReviewProfile.complete ? 'pill--neutral' : 'pill--flagged'}`}>
                {activeReviewProfile.complete ? 'All reviews run' : 'Reviews missing'}
              </span>
            </div>
          </div>

          {#if activeReviewProfile.requirements?.length === 0}
            <p class="empty-copy">No review requirements are configured for this profile.</p>
          {:else}
            <div class="review-profile-list">
              {#each activeReviewProfile.requirements as requirement (requirement.policyKey)}
                <div class="review-profile-item">
                  <div class="review-profile-item__body">
                    <strong>{requirement.label}</strong>
                    <span>
                      {#if requirement.missing}
                        No review run yet
                      {:else if requirement.latestStatus}
                        Latest status: {requirement.latestStatus}
                      {:else}
                        Review pending
                      {/if}
                    </span>
                  </div>
                  <div class="review-profile-item__meta">
                    {#if requirement.blocking}
                      <span class="pill pill--neutral">Blocking</span>
                    {/if}
                    <span class={`pill ${requirement.satisfied ? 'pill--passed' : requirement.missing ? 'pill--flagged' : 'pill--failed'}`}>
                      {requirement.satisfied ? 'Satisfied' : requirement.missing ? 'Missing' : 'Not satisfied'}
                    </span>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      <div class="review-actions">
        {#each activeProfileReviewActions as action (action.policyKey ?? action.kind)}
          <button
            type="button"
            disabled={reviewBusy !== null}
            onclick={() => void runReview(action)}
          >
            {#if reviewBusy === getReviewActionBusyKey(action)}
              Running {action.label.toLowerCase()}...
            {:else}
              Run {action.label}
            {/if}
          </button>
        {/each}
      </div>

      {#if hasCustomReview()}
        <label class="workflow-field">
          {customReviewLabel}
          <textarea
            rows="3"
            bind:value={customReviewText}
            placeholder="Add app-level review instructions"
          ></textarea>
        </label>
        <button
          type="button"
          disabled={reviewBusy !== null}
          onclick={() =>
            void runReview(
              createReviewAction(
                'custom',
                customReviewPolicyKey,
                customReviewLabel,
                customReviewText,
              ),
            )}
        >
          {#if reviewBusy === customReviewPolicyKey}
            Running {customReviewLabel.toLowerCase()}...
          {:else}
            {customReviewLabel}
          {/if}
        </button>
      {/if}

      <div class="review-list">
        <div class="section-caption">Recent reviews</div>
        {#if reviews.length === 0}
          <p class="empty-copy">No reviews have been run yet.</p>
        {:else}
          {#each reviews as review (review.id ?? `${review.kind}-${review.createdAt}`)}
            <div class="review-card">
              <div class="review-card__header">
                <strong>{review.kind}</strong>
                <span class={`pill pill--${review.status}`}>{review.status}</span>
              </div>
              <p>{review.summary}</p>
              <span>{review.findings?.length || 0} finding(s)</span>
            </div>
          {/each}
        {/if}
      </div>
    {/if}
  </div>

  {#if savedContentId}
    <div class="workflow-grid">
      <div class="workflow-section">
        <div class="workflow-section__header">
          <h4>Corrections</h4>
        </div>

        <label class="workflow-field">
          Summary
          <input
            type="text"
            bind:value={correctionSummary}
            placeholder="What was wrong?"
          />
        </label>

        <label class="workflow-field">
          Related fact
          <select bind:value={correctionFactId}>
            <option value="">General correction</option>
            {#each selectedFactsResolved as fact (fact.id)}
              <option value={fact.id ?? ''}>{fact.textRefined}</option>
            {/each}
          </select>
        </label>

        <label class="workflow-field">
          Corrected fact text
          <textarea
            rows="4"
            bind:value={correctedFactText}
            placeholder="Provide the corrected claim or wording"
          ></textarea>
        </label>

        <label class="workflow-field">
          Public note
          <textarea
            rows="3"
            bind:value={correctionPublicNote}
            placeholder="Optional public-facing correction note"
          ></textarea>
        </label>

        <label class="checkbox-row">
          <input type="checkbox" bind:checked={publishCorrection} />
          Publish immediately
        </label>

        <button
          type="button"
          disabled={correctionBusy || correctionSummary.trim().length === 0}
          onclick={() => void issueCorrection()}
        >
          {correctionBusy ? 'Issuing correction...' : 'Issue Correction'}
        </button>

        <div class="review-list">
          <div class="section-caption">Published history</div>
          {#if corrections.length === 0}
            <p class="empty-copy">No corrections issued.</p>
          {:else}
            {#each corrections as correction (correction.id ?? `${correction.correctionType}-${correction.createdAt}`)}
              <div class="review-card">
                <div class="review-card__header">
                  <strong>{correction.correctionType}</strong>
                  <span class={`pill pill--${correction.status}`}>{correction.status}</span>
                </div>
                <p>{correction.summary}</p>
                <span>{formatTimestamp(correction.publishedAt)}</span>
              </div>
            {/each}
          {/if}
        </div>
      </div>

      <div class="workflow-section">
        <div class="workflow-section__header">
          <h4>Versions</h4>
          <button
            type="button"
            class="secondary-button"
            disabled={versionBusy}
            onclick={() => void createSnapshot()}
          >
            {versionBusy ? 'Working...' : 'Create Snapshot'}
          </button>
        </div>

        {#if versions.length === 0}
          <p class="empty-copy">No versions saved yet.</p>
        {:else}
          <div class="review-list">
            {#each versions as version (version.id ?? `version-${version.version ?? 0}`)}
              <div class="review-card">
                <div class="review-card__header">
                  <strong>v{version.version}</strong>
                  <span class="pill pill--neutral">{version.kind}</span>
                </div>
                <p>{version.summary || 'Snapshot saved'}</p>
                <div class="version-card__footer">
                  <span>{formatTimestamp(version.createdAt)}</span>
                  <button
                    type="button"
                    class="secondary-button"
                    disabled={versionBusy || version.version === null || version.version === undefined}
                    onclick={() => {
                      if (
                        version.version !== null &&
                        version.version !== undefined
                      ) {
                        void restoreVersion(version.version);
                      }
                    }}
                  >
                    Restore
                  </button>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .factual-workflow {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .workflow-grid {
    display: grid;
    gap: 1.25rem;
  }

  @media (min-width: 900px) {
    .workflow-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  .workflow-section {
    background: var(--smrt-color-surface-container-low);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 0.75rem;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
  }

  .workflow-section__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  .workflow-section__header h4 {
    margin: 0;
    font-size: 1rem;
    color: var(--smrt-color-on-surface);
  }

  .section-status,
  .section-caption,
  .empty-copy,
  .review-card span,
  .fact-result span,
  .fact-chip span {
    color: var(--smrt-color-on-surface-variant);
    font-size: 0.85rem;
  }

  .fact-search,
  .review-actions,
  .version-card__footer {
    display: flex;
    gap: 0.75rem;
    align-items: center;
  }

  .fact-search input,
  .workflow-field input,
  .workflow-field textarea,
  .workflow-field select {
    width: 100%;
    box-sizing: border-box;
    padding: 0.75rem;
    border-radius: 0.5rem;
    border: 1px solid var(--smrt-color-outline);
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    font-family: inherit;
  }

  .workflow-field {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    color: var(--smrt-color-on-surface-variant);
    font-size: 0.875rem;
    font-weight: 500;
  }

  .fact-search button,
  .review-actions button,
  .workflow-section button {
    border: none;
    border-radius: 0.5rem;
    padding: 0.7rem 0.95rem;
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary, white);
    cursor: pointer;
    font-weight: 600;
  }

  .workflow-section button:disabled {
    cursor: not-allowed;
    opacity: 0.65;
  }

  .secondary-button {
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    border: 1px solid var(--smrt-color-outline-variant);
  }

  .fact-chip-list,
  .fact-catalog__list,
  .review-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .review-profile-list {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }

  .fact-chip,
  .fact-result,
  .review-card {
    background: var(--smrt-color-surface);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 0.75rem;
    padding: 0.85rem;
  }

  .fact-chip,
  .fact-result,
  .review-card__header,
  .version-card__footer {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .fact-chip__body,
  .fact-result__body {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .fact-chip__remove {
    background: transparent !important;
    color: var(--smrt-color-error) !important;
    padding: 0 !important;
  }

  .review-card {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .review-card__header {
    align-items: center;
  }

  .review-profile-card {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    background: var(--smrt-color-surface);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 0.75rem;
    padding: 0.85rem;
  }

  .review-profile-card__header,
  .review-profile-item,
  .review-profile-item__meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .review-profile-card__badges {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .review-profile-item {
    padding: 0.65rem 0.75rem;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 0.65rem;
    background: var(--smrt-color-surface-container-low);
  }

  .review-profile-item__body {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .pill {
    border-radius: 999px;
    padding: 0.2rem 0.55rem;
    font-size: 0.75rem;
    font-weight: 700;
    text-transform: capitalize;
  }

  .pill--passed {
    background: rgba(22, 163, 74, 0.14);
    color: #166534;
  }

  .pill--flagged {
    background: rgba(245, 158, 11, 0.16);
    color: #92400e;
  }

  .pill--failed,
  .pill--draft,
  .pill--retracted {
    background: rgba(220, 38, 38, 0.14);
    color: #991b1b;
  }

  .pill--published,
  .pill--neutral {
    background: rgba(59, 130, 246, 0.14);
    color: #1d4ed8;
  }

  .checkbox-row {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    color: var(--smrt-color-on-surface);
  }

  .workflow-error,
  .workflow-notice {
    margin: 0;
    border-radius: 0.6rem;
    padding: 0.75rem 0.9rem;
    font-size: 0.9rem;
  }

  .workflow-error {
    background: rgba(220, 38, 38, 0.1);
    color: #991b1b;
  }

  .workflow-notice {
    background: rgba(37, 99, 235, 0.1);
    color: #1d4ed8;
  }
</style>
