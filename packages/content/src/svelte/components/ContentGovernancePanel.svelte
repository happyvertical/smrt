<script lang="ts">
import { ConfirmDialog } from '@happyvertical/smrt-ui/feedback';
import { Input, Select, Textarea } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import {
  type ContentCorrectionData,
  type ContentGovernanceDefinitionsData,
  type ContentGovernanceProfileData,
  type ContentGovernanceStateData,
  type ContentReviewData,
  type ContentReviewPolicyData,
  type ContentReviewProfileData,
  type ContentTransparencyData,
  type ContentVersionData,
  createClient,
  type FactAuditClaimData,
  type FactAuditStateData,
  type FactData,
  type ResolvedContentGovernanceData,
} from '../../mock-smrt-client';
import { normalizeApiBaseUrl } from '../api';
import { M } from '../i18n.governance.js';

const { t } = useI18n();

export interface Props {
  /** Base URL for API requests to load facts, reviews, and governance state. */
  apiBaseUrl?: string;
  /** Identifier of the content, or 'new' if creating. */
  contentId?: string;
  /** Type of the draft content (e.g., article, post). */
  draftType?: string | null;
  /** Variant of the draft content within its type. */
  draftVariant?: string | null;
  /** IDs of facts currently linked to the content. */
  selectedFactIds?: string[];
  /** Fact objects corresponding to selectedFactIds. */
  selectedFacts?: FactData[];
  /** Default relationship type when adding facts (e.g., supports, contradicts). */
  defaultRelationship?: string;
  /** Key of the profile used to render reviews and requirements. */
  reviewProfileKey?: string;
  /** Label for the custom review workflow button. */
  customReviewLabel?: string;
  /** Instructions or guidance shown for custom review. */
  customReviewInstructions?: string;
  /** Policy key used for custom review submissions. */
  customReviewPolicyKey?: string;
  /** Show the searchable fact catalog browser in the panel. */
  showFactCatalog?: boolean;
  /** Fired when facts are linked or unlinked from the content. */
  onFactsChange?: (factIds: string[], facts: FactData[]) => void;
  /** Fired when governance state is loaded or changes. */
  onGovernanceStateChange?: (state: ContentGovernanceStateData | null) => void;
  /** Fired when fact audit state is loaded or changes. */
  onFactAuditChange?: (state: FactAuditStateData | null) => void;
  /** Panel sections to hide from the user interface. */
  hiddenSections?: ContentGovernancePanelSection[];
}

type ReviewKind = 'facts' | 'safety' | 'custom';
export type ContentGovernancePanelSection =
  | 'factAudit'
  | 'facts'
  | 'reviews'
  | 'transparency'
  | 'corrections'
  | 'versions';

interface ReviewAction {
  kind: ReviewKind;
  label: string;
  policyKey?: string;
  instructions?: string;
}

const FACT_CATALOG_PAGE_SIZE = 12;

let {
  apiBaseUrl = '/api/v1',
  contentId = 'new',
  draftType = null,
  draftVariant = null,
  selectedFactIds = [],
  selectedFacts = [],
  defaultRelationship = 'supports',
  reviewProfileKey = 'publication',
  customReviewLabel = 'Custom Review',
  customReviewInstructions = '',
  customReviewPolicyKey = 'custom',
  showFactCatalog = false,
  onFactsChange = undefined,
  onGovernanceStateChange = undefined,
  onFactAuditChange = undefined,
  hiddenSections = [],
}: Props = $props();

const client = $derived(createClient(normalizeApiBaseUrl(apiBaseUrl)));

let factQuery = $state('');
let catalogFacts = $state<FactData[]>([]);
let reviews = $state<ContentReviewData[]>([]);
let corrections = $state<ContentCorrectionData[]>([]);
let versions = $state<ContentVersionData[]>([]);
let transparencyPreview = $state<ContentTransparencyData | null>(null);
let publishedTransparency = $state<ContentTransparencyData | null>(null);
let factAudit = $state<FactAuditStateData | null>(null);
let governanceState = $state<ContentGovernanceStateData | null>(null);
let reviewProfiles = $state<ContentReviewProfileData[]>([]);
let governanceDefinitions = $state<ContentGovernanceDefinitionsData | null>(
  null,
);
let activeReviewProfileKey = $state('');
let activeCustomPolicyKey = $state('');

let catalogLoading = $state(false);
let catalogPage = $state(1);
let catalogHasNextPage = $state(false);
let catalogBrowseQuery = $state('');
let syncingFacts = $state(false);
let workflowLoading = $state(false);
let reviewBusy = $state<string | null>(null);
let correctionBusy = $state(false);
let versionBusy = $state(false);
let transparencyLoading = $state(false);
let factAuditBusy = $state(false);
let selectedClaimIds = $state<string[]>([]);

let catalogError = $state<string | null>(null);
let workflowError = $state<string | null>(null);
let workflowNotice = $state<string | null>(null);
let pendingRestoreVersion = $state<number | null>(null);
let catalogLoaded = $state(false);
let loadedContentId = $state<string | null>(null);
let resolvedDraftGovernanceKey = $state<string | null>(null);

let correctionSummary = $state('');
let correctionFactId = $state('');
let correctedFactText = $state('');
let correctionPublicNote = $state('');
let publishCorrection = $state(true);
let customReviewText = $state('');

const savedContentId = $derived(
  contentId && contentId !== 'new' ? contentId : null,
);
const draftGovernanceKey = $derived(
  draftType ? `${draftType}::${draftVariant || ''}` : null,
);
const hiddenSectionSet = $derived(new Set(hiddenSections));

function isSectionVisible(section: ContentGovernancePanelSection): boolean {
  return !hiddenSectionSet.has(section);
}

function getFactId(fact: FactData): string | null {
  return typeof fact.id === 'string' && fact.id.length > 0 ? fact.id : null;
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
  if (!claimId) {
    return;
  }

  selectedClaimIds = selectedClaimIds.includes(claimId)
    ? selectedClaimIds.filter((id) => id !== claimId)
    : [...selectedClaimIds, claimId];
}

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
const actionableFactAuditWarnings = $derived(
  (factAudit?.warnings ?? []).filter(
    (warning) => !isNonActionableFactAuditWarning(warning),
  ),
);
const selectedClaimCount = $derived(selectedClaimIds.length);

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
    .map((factId: string) => selectedFactsMap.get(factId))
    .filter((fact: FactData | undefined): fact is FactData => Boolean(fact)),
);
const activeReviewProfile = $derived(
  reviewProfiles.find(
    (profile) => profile.profileKey === activeReviewProfileKey,
  ) ?? null,
);
const activeUnsatisfiedRequirements = $derived(
  (activeReviewProfile?.requirements ?? []).filter(
    (requirement) => !requirement.satisfied,
  ),
);
const activeProfileReviewActions = $derived(
  getReviewActions(activeReviewProfile),
);
const availableCustomPolicies = $derived(
  (governanceState?.reviewPolicies ?? []).filter(
    (policy) => policy.kind === 'custom',
  ),
);
const activeCustomPolicy = $derived(
  availableCustomPolicies.find(
    (policy) => policy.key === activeCustomPolicyKey,
  ) ?? null,
);
const customReviewButtonLabel = $derived(
  activeCustomPolicy?.label || customReviewLabel,
);
const factCatalogRangeStart = $derived(
  catalogFacts.length > 0 ? (catalogPage - 1) * FACT_CATALOG_PAGE_SIZE + 1 : 0,
);
const factCatalogRangeEnd = $derived(
  catalogFacts.length > 0 ? factCatalogRangeStart + catalogFacts.length - 1 : 0,
);

$effect(() => {
  customReviewText = customReviewInstructions;
});

$effect(() => {
  activeReviewProfileKey = reviewProfileKey;
});

$effect(() => {
  activeCustomPolicyKey = customReviewPolicyKey;
});

$effect(() => {
  if (showFactCatalog && !catalogLoaded) {
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
    transparencyPreview = null;
    publishedTransparency = null;
    factAudit = null;
    onFactAuditChange?.(null);
    reviewProfiles = [];
    workflowError = null;
    workflowNotice = null;
  } else if (savedContentId !== loadedContentId) {
    loadedContentId = savedContentId;
    void loadSavedWorkflow();
  }
});

$effect(() => {
  if (savedContentId) {
    return;
  }

  if (!draftType) {
    governanceState = null;
    governanceDefinitions = null;
    onGovernanceStateChange?.(null);
    return;
  }

  if (draftGovernanceKey !== resolvedDraftGovernanceKey) {
    resolvedDraftGovernanceKey = draftGovernanceKey;
    void loadDraftGovernance();
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

function getRequirementStateLabel(requirement: {
  missing: boolean;
  stale?: boolean;
  satisfied: boolean;
  latestStatus: string | null;
}) {
  if (requirement.satisfied) {
    return 'Satisfied';
  }

  if (requirement.stale) {
    return 'Stale';
  }

  if (requirement.missing) {
    return 'Missing';
  }

  if (requirement.latestStatus === 'failed') {
    return 'Failed';
  }

  if (requirement.latestStatus === 'flagged') {
    return 'Flagged';
  }

  if (requirement.latestStatus === 'waived') {
    return 'Waived';
  }

  return 'Pending';
}

function getRequirementStateTone(requirement: {
  missing: boolean;
  stale?: boolean;
  satisfied: boolean;
  latestStatus: string | null;
}) {
  if (requirement.satisfied) {
    return 'passed';
  }

  if (requirement.latestStatus === 'failed') {
    return 'failed';
  }

  return 'flagged';
}

function getRequirementStateCopy(requirement: {
  missing: boolean;
  stale?: boolean;
  latestStatus: string | null;
  latestSummary: string | null;
}) {
  if (requirement.missing) {
    return 'No review run yet.';
  }

  if (requirement.stale) {
    return 'This review is stale because the content or linked evidence changed. Rerun required.';
  }

  if (requirement.latestSummary) {
    return requirement.latestSummary;
  }

  if (requirement.latestStatus) {
    return `Latest status: ${requirement.latestStatus}.`;
  }

  return 'Review pending.';
}

function getReviewTone(review: ContentReviewData) {
  switch (review.status) {
    case 'passed':
    case 'waived':
      return 'passed';
    case 'failed':
      return 'failed';
    default:
      return 'flagged';
  }
}

function getFindingTone(severity: string | undefined) {
  if (severity === 'error') {
    return 'failed';
  }

  if (severity === 'info') {
    return 'neutral';
  }

  return 'flagged';
}

function getTransparencyReferenceLabel(reference: {
  title?: string | null;
  url?: string | null;
}) {
  return reference.title || reference.url || 'Untitled reference';
}

function isNonActionableFactAuditWarning(warning: string) {
  return /^Asset .+ has no extracted text\.$/.test(warning.trim());
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

function resolveActiveCustomPolicyKey(
  policies: ContentReviewPolicyData[],
  preferredKey: string | null | undefined,
  fallbackKey: string,
) {
  const customPolicies = policies.filter((policy) => policy.kind === 'custom');

  if (
    preferredKey &&
    customPolicies.some((policy) => policy.key === preferredKey)
  ) {
    return preferredKey;
  }

  if (
    fallbackKey &&
    customPolicies.some((policy) => policy.key === fallbackKey)
  ) {
    return fallbackKey;
  }

  return customPolicies[0]?.key ?? fallbackKey;
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

async function searchFacts(query = factQuery, page = 1) {
  const nextPage = Math.max(1, Math.floor(page));
  if (governanceState && !governanceState.factLinkingEnabled) {
    catalogFacts = [];
    catalogPage = 1;
    catalogHasNextPage = false;
    catalogBrowseQuery = '';
    return;
  }

  catalogLoading = true;
  catalogError = null;

  try {
    const response = await client.contents.browseFacts(query, {
      limit: FACT_CATALOG_PAGE_SIZE + 1,
      offset: (nextPage - 1) * FACT_CATALOG_PAGE_SIZE,
      latestOnly: true,
    });
    const rows = response.data || [];
    catalogFacts = rows.slice(0, FACT_CATALOG_PAGE_SIZE);
    catalogPage = nextPage;
    catalogHasNextPage = rows.length > FACT_CATALOG_PAGE_SIZE;
    catalogBrowseQuery = query;
  } catch (err) {
    catalogFacts = [];
    catalogHasNextPage = false;
    catalogError =
      (err instanceof Error ? err.message : '') || 'Failed to browse facts';
  } finally {
    catalogLoading = false;
  }
}

function searchFactsFirstPage() {
  void searchFacts(factQuery, 1);
}

function browsePreviousFacts() {
  if (catalogPage <= 1 || catalogLoading) {
    return;
  }

  void searchFacts(catalogBrowseQuery, catalogPage - 1);
}

function browseNextFacts() {
  if (!catalogHasNextPage || catalogLoading) {
    return;
  }

  void searchFacts(catalogBrowseQuery, catalogPage + 1);
}

async function syncFactsIfSaved(nextFacts: FactData[]) {
  updateSelectedFacts(nextFacts);

  if (governanceState && !governanceState.factLinkingEnabled) {
    return;
  }

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
    await Promise.all([refreshGovernanceState(), refreshTransparency()]);
    workflowNotice = 'Saved fact associations.';
  } catch (err) {
    workflowError =
      (err instanceof Error ? err.message : '') || 'Failed to sync facts';
  } finally {
    syncingFacts = false;
  }
}

async function repairFactAudit() {
  if (!savedContentId || factAuditBusy) {
    return;
  }

  factAuditBusy = true;
  workflowError = null;
  workflowNotice = null;

  try {
    const response = await client.contents.repairFactAudit(savedContentId);
    factAudit = response.data;
    workflowNotice = `Fact audit repaired: ${response.data.counts.total} claim(s) checked.`;
    onFactAuditChange?.(response.data);
    const factsResponse = await client.contents.getFacts(savedContentId);
    updateSelectedFacts(factsResponse.data.facts || []);
  } catch (err) {
    workflowError =
      (err instanceof Error ? err.message : '') ||
      'Failed to repair fact audit';
  } finally {
    factAuditBusy = false;
  }
}

async function recheckFactClaims(claimIds: string[]) {
  if (!savedContentId || factAuditBusy || claimIds.length === 0) {
    return;
  }

  factAuditBusy = true;
  workflowError = null;
  workflowNotice = null;

  try {
    const response = await client.contents.recheckFactClaims(savedContentId, {
      claimFactIds: claimIds,
    });
    factAudit = response.data;
    workflowNotice = `Rechecked ${claimIds.length} claim${claimIds.length === 1 ? '' : 's'} against current evidence.`;
    selectedClaimIds = selectedClaimIds.filter((id) => !claimIds.includes(id));
    onFactAuditChange?.(response.data);
  } catch (err) {
    workflowError =
      (err instanceof Error ? err.message : '') ||
      'Failed to recheck claim support';
  } finally {
    factAuditBusy = false;
  }
}

async function recheckSelectedClaims() {
  await recheckFactClaims(selectedClaimIds);
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
    selectedFactsResolved.filter(
      (fact: FactData) => getFactId(fact) !== factId,
    ),
  );
}

async function loadDraftGovernance() {
  if (!draftType) {
    governanceState = null;
    governanceDefinitions = null;
    reviewProfiles = [];
    onGovernanceStateChange?.(null);
    return;
  }

  workflowLoading = true;
  workflowError = null;

  try {
    const [definitionsResponse, resolvedResponse] = await Promise.all([
      client.contents.getGovernanceDefinitions(),
      client.contents.resolveGovernance({
        type: draftType,
        variant: draftVariant,
      }),
    ]);

    governanceDefinitions = definitionsResponse.data;
    governanceState = {
      ...resolvedResponse.data,
      reviewProfiles: [],
    };
    reviewProfiles = [];
    onGovernanceStateChange?.(governanceState);
    activeReviewProfileKey =
      governanceState.publicationProfileKey || reviewProfileKey;
    activeCustomPolicyKey = resolveActiveCustomPolicyKey(
      governanceState.reviewPolicies || [],
      activeCustomPolicyKey,
      customReviewPolicyKey,
    );
  } catch (err) {
    governanceState = null;
    governanceDefinitions = null;
    reviewProfiles = [];
    onGovernanceStateChange?.(null);
    workflowError =
      (err instanceof Error ? err.message : '') ||
      'Failed to resolve content governance';
  } finally {
    workflowLoading = false;
  }
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
      governanceResponse,
      governanceDefinitionsResponse,
      factAuditResponse,
      transparencyPreviewResponse,
      publishedTransparencyResponse,
    ] = await Promise.all([
      client.contents.getFacts(savedContentId),
      client.contents.getReviews(savedContentId),
      client.contents.getCorrections(savedContentId),
      client.contents.getVersions(savedContentId),
      client.contents.getGovernanceState(savedContentId),
      client.contents.getGovernanceDefinitions(),
      client.contents.getFactAudit(savedContentId),
      client.contents.getTransparencyPreview(savedContentId),
      client.contents.getPublishedTransparency(savedContentId),
    ]);

    updateSelectedFacts(factsResponse.data.facts || []);
    reviews = reviewsResponse.data;
    corrections = correctionsResponse.data;
    versions = versionsResponse.data;
    transparencyPreview = transparencyPreviewResponse.data;
    publishedTransparency = publishedTransparencyResponse.data;
    factAudit = factAuditResponse.data;
    onFactAuditChange?.(factAudit);
    governanceState = governanceResponse.data;
    governanceDefinitions = governanceDefinitionsResponse.data;
    reviewProfiles = governanceResponse.data.reviewProfiles || [];
    onGovernanceStateChange?.(governanceResponse.data);
    activeReviewProfileKey = resolveActiveReviewProfileKey(
      governanceResponse.data.reviewProfiles || [],
      activeReviewProfileKey,
      reviewProfileKey,
    );
    activeCustomPolicyKey = resolveActiveCustomPolicyKey(
      governanceResponse.data.reviewPolicies || [],
      activeCustomPolicyKey,
      customReviewPolicyKey,
    );
  } catch (err) {
    workflowError =
      (err instanceof Error ? err.message : '') ||
      'Failed to load governance workflow state';
  } finally {
    workflowLoading = false;
  }
}

export async function triggerReview(actionKind: string) {
  const action = activeProfileReviewActions.find(
    (a) =>
      a.kind === actionKind ||
      a.label.toLowerCase().includes(actionKind.toLowerCase()),
  );
  if (action) {
    await runReview(action);
  } else if (actionKind.toLowerCase() === 'custom') {
    await runReview(
      createReviewAction(
        'custom',
        activeCustomPolicy?.key || customReviewPolicyKey,
        customReviewButtonLabel,
        customReviewText || undefined,
      ),
    );
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
    const payload: Record<string, unknown> = {
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
    await Promise.all([refreshGovernanceState(), refreshTransparency()]);
    workflowNotice = `${action.label} completed.`;
    await refreshVersions();
  } catch (err) {
    workflowError =
      (err instanceof Error ? err.message : '') ||
      'Failed to run content review';
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
  } catch (err) {
    workflowError =
      (err instanceof Error ? err.message : '') || 'Failed to issue correction';
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
    await Promise.all([refreshVersions(), refreshTransparency()]);
  } catch (err) {
    workflowError =
      (err instanceof Error ? err.message : '') ||
      'Failed to create version snapshot';
  } finally {
    versionBusy = false;
  }
}

function requestRestoreVersion(versionNumber: number) {
  if (!savedContentId) {
    return;
  }
  pendingRestoreVersion = versionNumber;
}

function cancelRestoreVersion() {
  pendingRestoreVersion = null;
}

function confirmRestoreVersion() {
  const versionNumber = pendingRestoreVersion;
  pendingRestoreVersion = null;
  if (versionNumber !== null) {
    void restoreVersion(versionNumber);
  }
}

async function restoreVersion(versionNumber: number) {
  if (!savedContentId) {
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
    workflowNotice = `Restored version ${versionNumber}.`;
    await loadSavedWorkflow();
  } catch (err) {
    workflowError =
      (err instanceof Error ? err.message : '') || 'Failed to restore version';
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

async function refreshTransparency() {
  if (!savedContentId) {
    transparencyPreview = null;
    publishedTransparency = null;
    return;
  }

  transparencyLoading = true;

  try {
    const [previewResponse, publishedResponse] = await Promise.all([
      client.contents.getTransparencyPreview(savedContentId),
      client.contents.getPublishedTransparency(savedContentId),
    ]);
    transparencyPreview = previewResponse.data;
    publishedTransparency = publishedResponse.data;
  } finally {
    transparencyLoading = false;
  }
}

async function refreshGovernanceState() {
  if (!savedContentId) {
    await loadDraftGovernance();
    return;
  }

  const response = await client.contents.getGovernanceState(savedContentId);
  governanceState = response.data;
  reviewProfiles = response.data.reviewProfiles || [];
  onGovernanceStateChange?.(response.data);
  activeReviewProfileKey = resolveActiveReviewProfileKey(
    response.data.reviewProfiles || [],
    activeReviewProfileKey,
    reviewProfileKey,
  );
  activeCustomPolicyKey = resolveActiveCustomPolicyKey(
    response.data.reviewPolicies || [],
    activeCustomPolicyKey,
    customReviewPolicyKey,
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

function canRunCustomReview() {
  return Boolean(activeCustomPolicy) || customReviewText.trim().length > 0;
}

function getCorrectionProvenanceCopy(correction: ContentCorrectionData) {
  const metadata = correction.metadata || {};

  if (metadata.draftVersionNumber) {
    return `Auto-created draft v${metadata.draftVersionNumber} for editorial follow-up.`;
  }

  return null;
}

function getVersionProvenanceCopy(version: ContentVersionData) {
  const metadata = version.metadata || {};

  if (metadata.sourceCorrectionVersionNumber) {
    return `Generated from correction version v${metadata.sourceCorrectionVersionNumber}.`;
  }

  if (metadata.policyKey) {
    return `Created from the ${metadata.policyKey} review flow.`;
  }

  if (version.kind === 'publication') {
    return 'Frozen public transparency snapshot.';
  }

  return null;
}
</script>

<div class="smrt-content-governance-panel__root" data-smrt-component="ContentGovernancePanel">
  {#if isSectionVisible('factAudit')}
    <details class="smrt-content-governance-panel__drawer" data-smrt-part="drawer" open={(factAudit?.counts.total ?? 0) > 0}>
    <summary class="smrt-content-governance-panel__drawer-header" data-smrt-part="drawer-header">
      <div style="display: flex; align-items: center; gap: 0.5rem;">
        {t(M['content.governance_panel.article_claim_audit'])}
        {#if factAuditBusy}
          <span class="smrt-content-governance-panel__section-status" data-smrt-part="status" style="font-size: 0.875rem; font-weight: 400; color: var(--smrt-color-outline);">Repairing...</span>
        {/if}
      </div>
      <svg class="smrt-content-governance-panel__drawer-icon" data-smrt-part="icon" viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
    </summary>
    <div class="smrt-content-governance-panel__drawer-body" data-smrt-part="drawer-body">
      {#if !savedContentId}
        <p class="smrt-content-governance-panel__empty-copy" data-smrt-part="empty">{t(M['content.governance_panel.save_to_audit_claims'])}</p>
      {:else}
        <div class="smrt-content-governance-panel__claim-audit-toolbar" data-smrt-part="toolbar">
          <div class="smrt-content-governance-panel__claim-audit-counts" data-smrt-part="meta">
            <span><strong>{factAudit?.counts.total ?? 0}</strong> {t(M['content.governance_panel.article_claims'])}</span>
            <span><strong>{factAudit?.counts.supported ?? 0}</strong> supported</span>
            <span><strong>{factAudit?.counts.unsupported ?? 0}</strong> unsupported</span>
            <span><strong>{factAudit?.counts.contradicted ?? 0}</strong> contradicted</span>
            <span><strong>{factAudit?.counts.needs_review ?? 0}</strong> review</span>
          </div>
          <Button
            variant="secondary"
            type="button"
            disabled={factAuditBusy || selectedClaimCount === 0}
            onclick={() => void recheckSelectedClaims()}
          >
            {factAuditBusy ? 'Checking...' : `Recheck selected (${selectedClaimCount})`}
          </Button>
          <Button
            variant="secondary"
            type="button"
            disabled={factAuditBusy}
            onclick={() => void repairFactAudit()}
          >
            {factAuditBusy ? 'Repairing...' : 'Repair audit'}
          </Button>
        </div>
        <p class="smrt-content-governance-panel__claim-audit-help" data-smrt-part="hint">
          {t(M['content.governance_panel.article_claims_help'])}
        </p>

        {#if actionableFactAuditWarnings.length}
          <div class="smrt-content-governance-panel__claim-audit-warnings" data-smrt-part="warning">
            {#each actionableFactAuditWarnings as warning}
              <p>{warning}</p>
            {/each}
          </div>
        {/if}

        {#if !factAudit || factAudit.counts.total === 0}
          <p class="smrt-content-governance-panel__empty-copy" data-smrt-part="empty">
            {t(M['content.governance_panel.no_claim_audit_generated'])}
          </p>
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
              <div class="smrt-content-governance-panel__claim-audit-group" data-smrt-part="section">
                <div class="smrt-content-governance-panel__section-caption" data-smrt-part="caption">{t(M['content.governance_panel.group_article_claims'], { group: group[1] })}</div>
                {#each groupClaims as claim (claim.id ?? claim.claimQuote ?? claim.fact.textRefined)}
                  <details class="smrt-content-governance-panel__claim-audit-item" data-smrt-part="item">
                    <summary>
                      <label class="smrt-content-governance-panel__claim-audit-select" data-smrt-part="select">
                        <!-- raw-primitive-allow: native checkbox; no Provider-free checkbox primitive (Toggle is a switch with different semantics, CheckboxInput requires a Provider) -->
                        <input
                          type="checkbox"
                          checked={isClaimSelected(claim)}
                          disabled={!getClaimId(claim)}
                          onchange={() => toggleClaimSelection(claim)}
                        />
                      </label>
                      <span class={`smrt-content-governance-panel__pill smrt-content-governance-panel__pill--${claim.supportStatus === 'supported' ? 'passed' : claim.supportStatus === 'contradicted' ? 'failed' : 'flagged'}`} data-smrt-part="badge">
                        {claim.supportStatus.replace('_', ' ')}
                      </span>
                      <strong>{claim.fact.textRefined || claim.claimQuote || claim.id}</strong>
                    </summary>
                    <div class="smrt-content-governance-panel__claim-audit-item-body" data-smrt-part="body">
                      <div class="smrt-content-governance-panel__claim-audit-item-actions" data-smrt-part="actions">
                        <Button
                          variant="secondary"
                          type="button"
                          disabled={factAuditBusy || !getClaimId(claim)}
                          onclick={() => {
                            const claimId = getClaimId(claim);
                            if (claimId) void recheckFactClaims([claimId]);
                          }}
                        >
                          {t(M['content.governance_panel.recheck_support'])}
                        </Button>
                      </div>
                      {#if claim.claimQuote}
                        <p><strong>{t(M['content.governance_panel.article_claim_label'])}</strong> {claim.claimQuote}</p>
                      {/if}
                      {#if claim.rationale}
                        <p><strong>{t(M['content.governance_panel.support_assessment_label'])}</strong> {claim.rationale}</p>
                      {/if}
                      {#if claim.evidence?.length}
                        <div class="smrt-content-governance-panel__claim-audit-evidence" data-smrt-part="list">
                          <div class="smrt-content-governance-panel__section-caption" data-smrt-part="caption">{t(M['content.governance_panel.claim_excerpt'])}</div>
                          {#each claim.evidence as evidence (evidence.id ?? evidence.evidenceKey)}
                            <p>{evidence.quote || evidence.locator || evidence.sourceTitle}</p>
                          {/each}
                        </div>
                      {/if}
                      {#if claim.matchedFacts?.length}
                        <div class="smrt-content-governance-panel__claim-audit-evidence" data-smrt-part="list">
                          <div class="smrt-content-governance-panel__section-caption" data-smrt-part="caption">{t(M['content.governance_panel.based_on_source_evidence'])}</div>
                          {#each claim.matchedFacts as matched (matched.fact.id ?? matched.fact.textRefined)}
                            <div class="smrt-content-governance-panel__claim-audit-match" data-smrt-part="item">
                              <strong>{t(M['content.governance_panel.source_claim_label'])} {matched.fact.textRefined || matched.fact.textRaw || matched.fact.id}</strong>
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
                        <p><strong>{t(M['content.governance_panel.based_on_label'])}</strong> {t(M['content.governance_panel.no_supporting_source_evidence'])}</p>
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
    </details>
  {/if}

  {#if isSectionVisible('facts') && (showFactCatalog || selectedFactsResolved.length > 0)}
    <details class="smrt-content-governance-panel__drawer" data-smrt-part="drawer" open={selectedFactsResolved.length > 0}>
      <summary class="smrt-content-governance-panel__drawer-header" data-smrt-part="drawer-header">
        <div style="display: flex; align-items: center; gap: 0.5rem;">
          {t(M['content.governance_panel.manual_fact_links'])}
          {#if syncingFacts}
            <span class="smrt-content-governance-panel__section-status" data-smrt-part="status" style="font-size: 0.875rem; font-weight: 400; color: var(--smrt-color-outline);">{t(M['content.governance_panel.saving_links'])}</span>
          {/if}
        </div>
        <svg class="smrt-content-governance-panel__drawer-icon" data-smrt-part="icon" viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
      </summary>
      <div class="smrt-content-governance-panel__drawer-body" data-smrt-part="drawer-body">
        {#if governanceState && !governanceState.factLinkingEnabled}
          <p class="smrt-content-governance-panel__empty-copy" data-smrt-part="empty">
            {t(M['content.governance_panel.fact_linking_not_enabled'])}
          </p>
        {:else}
          <div class="smrt-content-governance-panel__selected-facts" data-smrt-part="list">
            <div class="smrt-content-governance-panel__section-caption" data-smrt-part="caption">{t(M['content.governance_panel.manually_linked_facts'])}</div>
            {#if selectedFactsResolved.length === 0}
              <p class="smrt-content-governance-panel__empty-copy" data-smrt-part="empty">{t(M['content.governance_panel.no_manually_linked_facts'])}</p>
            {:else}
              <div class="smrt-content-governance-panel__fact-chip-list" data-smrt-part="list">
                {#each selectedFactsResolved as fact (fact.id ?? fact.textRefined)}
                  <div class="smrt-content-governance-panel__fact-chip" data-smrt-part="item">
                    <div class="smrt-content-governance-panel__fact-chip-body" data-smrt-part="body">
                      <strong>{fact.textRefined}</strong>
                      <span>
                        {fact.status} · confidence {formatPercent(fact.confidence)}
                      </span>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      type="button"
                      class="fact-chip__remove"
                      onclick={() => fact.id && removeFact(fact.id)}
                    >
                      Remove
                    </Button>
                  </div>
                {/each}
              </div>
            {/if}
          </div>

          {#if showFactCatalog}
            <div class="smrt-content-governance-panel__fact-search" data-smrt-part="search">
              <Input
                type="text"
                bind:value={factQuery}
                placeholder={t(M['content.governance_panel.search_fact_catalog'])}
              />
              <Button variant="primary" type="button" onclick={searchFactsFirstPage}>
                Search
              </Button>
            </div>

            {#if catalogError}
              <p class="smrt-content-governance-panel__workflow-error" data-smrt-part="error" role="alert" aria-live="assertive">{catalogError}</p>
            {/if}

            <div class="smrt-content-governance-panel__fact-catalog" data-smrt-part="panel">
              <div class="smrt-content-governance-panel__section-caption" data-smrt-part="caption">{t(M['content.governance_panel.fact_catalog'])}</div>
              {#if catalogLoading}
                <p class="smrt-content-governance-panel__empty-copy" data-smrt-part="empty">{t(M['content.governance_panel.loading_facts'])}</p>
              {:else if catalogFacts.length === 0}
                <p class="smrt-content-governance-panel__empty-copy" data-smrt-part="empty">{t(M['content.governance_panel.no_facts_matched'])}</p>
              {:else}
                <div class="smrt-content-governance-panel__fact-catalog-list" data-smrt-part="list">
                  {#each catalogFacts as fact (fact.id ?? fact.textRefined)}
                    <div class="smrt-content-governance-panel__fact-result" data-smrt-part="item">
                      <div class="smrt-content-governance-panel__fact-result-body" data-smrt-part="body">
                        <strong>{fact.textRefined}</strong>
                        <span>
                          {fact.status} · {fact.domain || 'general'} · confidence {formatPercent(fact.confidence)}
                        </span>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        type="button"
                        disabled={!fact.id || selectedFactIds.includes(fact.id ?? '')}
                        onclick={() => addFact(fact)}
                      >
                        {!fact.id || selectedFactIds.includes(fact.id ?? '') ? 'Selected' : 'Add'}
                      </Button>
                    </div>
                  {/each}
                </div>
              {/if}

              {#if catalogFacts.length > 0 || catalogPage > 1}
                <div class="smrt-content-governance-panel__fact-pagination" data-smrt-part="pagination" aria-label={t(M['content.governance_panel.fact_catalog_pagination'])}>
                  <span>
                    Page {catalogPage}
                    {#if catalogFacts.length > 0}
                      · {factCatalogRangeStart}-{factCatalogRangeEnd}
                    {/if}
                  </span>
                  <div class="smrt-content-governance-panel__fact-pagination-actions" data-smrt-part="actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      type="button"
                      disabled={catalogLoading || catalogPage <= 1}
                      onclick={browsePreviousFacts}
                    >
                      Previous
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      type="button"
                      disabled={catalogLoading || !catalogHasNextPage}
                      onclick={browseNextFacts}
                    >
                      Next
                    </Button>
                  </div>
                </div>
              {/if}
            </div>
          {/if}
        {/if}
      </div>
    </details>
  {/if}

  {#if isSectionVisible('reviews')}
    <details class="smrt-content-governance-panel__drawer" data-smrt-part="drawer">
    <summary class="smrt-content-governance-panel__drawer-header" data-smrt-part="drawer-header">
      <div style="display: flex; align-items: center; gap: 0.5rem;">
        Review
        {#if workflowLoading}
          <span class="smrt-content-governance-panel__section-status" data-smrt-part="status" style="font-size: 0.875rem; font-weight: 400; color: var(--smrt-color-outline);">Loading...</span>
        {/if}
      </div>
      <svg class="smrt-content-governance-panel__drawer-icon" data-smrt-part="icon" viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
    </summary>
    <div class="smrt-content-governance-panel__drawer-body" data-smrt-part="drawer-body">

    {#if workflowError}
      <p class="smrt-content-governance-panel__workflow-error" data-smrt-part="error" role="alert" aria-live="assertive">{workflowError}</p>
    {/if}

    {#if workflowNotice}
      <p class="smrt-content-governance-panel__workflow-notice" data-smrt-part="notice" role="status" aria-live="polite">{workflowNotice}</p>
    {/if}

    {#if !savedContentId}
      <p class="smrt-content-governance-panel__empty-copy" data-smrt-part="empty">
        {t(M['content.governance_panel.save_to_run_governance'])}
      </p>
    {:else}
      {#if reviewProfiles.length > 0}
        <label class="smrt-content-governance-panel__workflow-field" data-smrt-part="field">
          {t(M['content.governance_panel.review_profile'])}
          <Select bind:value={activeReviewProfileKey}>
            {#each reviewProfiles as profile (profile.profileKey)}
              <option value={profile.profileKey}>
                {formatProfileLabel(profile.profileKey)}
              </option>
            {/each}
          </Select>
        </label>
      {/if}

      {#if activeReviewProfile}
        <div class="smrt-content-governance-panel__review-profile-card" data-smrt-part="panel">
          <div class="smrt-content-governance-panel__review-profile-card-header" data-smrt-part="header">
            <strong>{formatProfileLabel(activeReviewProfile.profileKey)}</strong>
            <div class="smrt-content-governance-panel__review-profile-card-badges" data-smrt-part="badge">
              <span class={`smrt-content-governance-panel__pill ${activeReviewProfile.ready ? 'smrt-content-governance-panel__pill--passed' : 'smrt-content-governance-panel__pill--failed'}`} data-smrt-part="badge">
                {activeReviewProfile.ready ? 'Blocking-ready' : 'Blocking issues'}
              </span>
              <span class={`smrt-content-governance-panel__pill ${activeReviewProfile.complete ? 'smrt-content-governance-panel__pill--neutral' : 'smrt-content-governance-panel__pill--flagged'}`} data-smrt-part="badge">
                {activeReviewProfile.complete ? 'All reviews run' : 'Reviews missing'}
              </span>
            </div>
          </div>

          {#if activeUnsatisfiedRequirements.length > 0}
            <div class="smrt-content-governance-panel__review-profile-callout" data-smrt-part="warning">
              <strong>{t(M['content.governance_panel.needs_attention'])}</strong>
              <span>
                {t(M['content.governance_panel.requirements_need_attention'], { count: activeUnsatisfiedRequirements.length })}
              </span>
            </div>
          {/if}

          {#if activeReviewProfile.requirements?.length === 0}
            <p class="smrt-content-governance-panel__empty-copy" data-smrt-part="empty">{t(M['content.governance_panel.no_review_requirements'])}</p>
          {:else}
            <div class="smrt-content-governance-panel__review-profile-list" data-smrt-part="list">
              {#each activeReviewProfile.requirements as requirement (requirement.policyKey)}
                <div class="smrt-content-governance-panel__review-profile-item" data-smrt-part="item">
                  <div class="smrt-content-governance-panel__review-profile-item-body" data-smrt-part="body">
                    <strong>{requirement.label}</strong>
                    <span>{getRequirementStateCopy(requirement)}</span>
                  </div>
                  <div class="smrt-content-governance-panel__review-profile-item-meta" data-smrt-part="meta">
                    {#if requirement.blocking}
                      <span class="smrt-content-governance-panel__pill smrt-content-governance-panel__pill--neutral" data-smrt-part="badge">Blocking</span>
                    {/if}
                    <span class={`smrt-content-governance-panel__pill smrt-content-governance-panel__pill--${getRequirementStateTone(requirement)}`} data-smrt-part="badge">
                      {getRequirementStateLabel(requirement)}
                    </span>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {/if}

      <div class="smrt-content-governance-panel__review-actions" data-smrt-part="actions">
        {#each activeProfileReviewActions as action (action.policyKey ?? action.kind)}
          <Button
            variant="primary"
            type="button"
            disabled={reviewBusy !== null}
            onclick={() => void runReview(action)}
          >
            {#if reviewBusy === getReviewActionBusyKey(action)}
              Running {action.label.toLowerCase()}...
            {:else}
              Run {action.label}
            {/if}
          </Button>
        {/each}
      </div>

      <div class="smrt-content-governance-panel__workflow-field-group" data-smrt-part="controls">
        {#if availableCustomPolicies.length > 0}
          <label class="smrt-content-governance-panel__workflow-field" data-smrt-part="field">
            {t(M['content.governance_panel.app_review_policy'])}
            <Select bind:value={activeCustomPolicyKey}>
              {#each availableCustomPolicies as policy (policy.key)}
                <option value={policy.key}>
                  {policy.label}
                </option>
              {/each}
            </Select>
          </label>
        {/if}

        <label class="smrt-content-governance-panel__workflow-field" data-smrt-part="field">
          {customReviewButtonLabel}
          <Textarea
            rows={3}
            bind:value={customReviewText}
            placeholder={t(M['content.governance_panel.optional_review_instructions'])}
          ></Textarea>
        </label>
        <Button
          variant="primary"
          type="button"
          disabled={reviewBusy !== null || !canRunCustomReview()}
          onclick={() =>
            void runReview(
              createReviewAction(
                'custom',
                activeCustomPolicy?.key || customReviewPolicyKey,
                customReviewButtonLabel,
                customReviewText || undefined,
              ),
            )}
        >
          {#if reviewBusy === (activeCustomPolicy?.key || customReviewPolicyKey)}
            Running {customReviewButtonLabel.toLowerCase()}...
          {:else}
            Run {customReviewButtonLabel}
          {/if}
        </Button>
      </div>

      <div class="smrt-content-governance-panel__review-list" data-smrt-part="list">
        <div class="smrt-content-governance-panel__section-caption" data-smrt-part="caption">{t(M['content.governance_panel.recent_reviews'])}</div>
        {#if reviews.length === 0}
          <p class="smrt-content-governance-panel__empty-copy" data-smrt-part="empty">{t(M['content.governance_panel.no_reviews_run'])}</p>
        {:else}
          {#each reviews as review (review.id ?? `${review.kind}-${review.createdAt}`)}
            <div class="smrt-content-governance-panel__review-card" data-smrt-part="item">
              <div class="smrt-content-governance-panel__review-card-header" data-smrt-part="header">
                <strong>{review.policyKey || review.kind}</strong>
                <span class={`smrt-content-governance-panel__pill smrt-content-governance-panel__pill--${getReviewTone(review)}`} data-smrt-part="badge">
                  {review.status || 'pending'}
                </span>
              </div>
              <p>{review.summary || 'Review completed.'}</p>
              {#if review.findings && review.findings.length > 0}
                <div class="smrt-content-governance-panel__review-findings" data-smrt-part="list">
                  {#each review.findings.slice(0, 2) as finding (`${review.id}-${finding.title ?? finding.detail}`)}
                    <div class="smrt-content-governance-panel__review-finding" data-smrt-part="item">
                      <span class={`smrt-content-governance-panel__pill smrt-content-governance-panel__pill--${getFindingTone(finding.severity)}`} data-smrt-part="badge">
                        {finding.severity || 'warning'}
                      </span>
                      <div class="smrt-content-governance-panel__review-finding-body" data-smrt-part="body">
                        <strong>{finding.title || 'Finding'}</strong>
                        <span>{finding.detail || 'No detail provided.'}</span>
                      </div>
                    </div>
                  {/each}
                  {#if review.findings.length > 2}
                    <span>{t(M['content.governance_panel.more_findings'], { count: review.findings.length - 2 })}</span>
                  {/if}
                </div>
              {:else}
                <span>0 finding(s)</span>
              {/if}
            </div>
          {/each}
        {/if}
      </div>
    {/if}
  </div>
    </details>
  {/if}

  {#if isSectionVisible('transparency')}
    <details class="smrt-content-governance-panel__drawer" data-smrt-part="drawer">
    <summary class="smrt-content-governance-panel__drawer-header" data-smrt-part="drawer-header">
      <div style="display: flex; align-items: center; gap: 0.5rem;">
        Transparency
        {#if transparencyLoading}
          <span class="smrt-content-governance-panel__section-status" data-smrt-part="status" style="font-size: 0.875rem; font-weight: 400; color: var(--smrt-color-outline);">Loading...</span>
        {/if}
      </div>
      <svg class="smrt-content-governance-panel__drawer-icon" data-smrt-part="icon" viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
    </summary>
    <div class="smrt-content-governance-panel__drawer-body" data-smrt-part="drawer-body">

    {#if !savedContentId}
      <p class="smrt-content-governance-panel__empty-copy" data-smrt-part="empty">
        {t(M['content.governance_panel.save_to_preview_transparency'])}
      </p>
    {:else if governanceState && !governanceState.transparencyEnabled}
      <p class="smrt-content-governance-panel__empty-copy" data-smrt-part="empty">
        {t(M['content.governance_panel.transparency_snapshots_not_enabled'])}
      </p>
    {:else if !transparencyPreview}
      <p class="smrt-content-governance-panel__empty-copy" data-smrt-part="empty">{t(M['content.governance_panel.no_transparency_preview'])}</p>
    {:else}
      <p class="smrt-content-governance-panel__section-caption" data-smrt-part="caption">
        {t(M['content.governance_panel.transparency_preview_explainer'])}
      </p>

      <div class="smrt-content-governance-panel__transparency-stats" data-smrt-part="list">
        <div class="smrt-content-governance-panel__transparency-stat" data-smrt-part="item">
          <strong>{transparencyPreview.factsUsed.length}</strong>
          <span>{t(M['content.governance_panel.facts_used'])}</span>
        </div>
        <div class="smrt-content-governance-panel__transparency-stat" data-smrt-part="item">
          <strong>{transparencyPreview.references.length}</strong>
          <span>References</span>
        </div>
        <div class="smrt-content-governance-panel__transparency-stat" data-smrt-part="item">
          <strong>{transparencyPreview.otherExtractedFacts.length}</strong>
          <span>{t(M['content.governance_panel.other_extracted_facts'])}</span>
        </div>
        <div class="smrt-content-governance-panel__transparency-stat" data-smrt-part="item">
          <strong>{transparencyPreview.corrections.length}</strong>
          <span>{t(M['content.governance_panel.public_corrections'])}</span>
        </div>
      </div>

      <div class="smrt-content-governance-panel__transparency-grid" data-smrt-part="list">
        <div class="smrt-content-governance-panel__transparency-card" data-smrt-part="panel">
          <div class="smrt-content-governance-panel__transparency-card-header" data-smrt-part="header">
            <strong>{t(M['content.governance_panel.current_preview'])}</strong>
            <span class="smrt-content-governance-panel__pill smrt-content-governance-panel__pill--neutral" data-smrt-part="badge">{transparencyPreview.snapshotKind}</span>
          </div>
          <span>
            {#if transparencyPreview.generation.publicPrompt}
              {t(M['content.governance_panel.public_prompt_set'])}
            {:else}
              {t(M['content.governance_panel.no_public_prompt_exposed'])}
            {/if}
          </span>
          {#if transparencyPreview.generation.publicPrompt}
            <p class="smrt-content-governance-panel__transparency-card-prompt" data-smrt-part="copy">
              {transparencyPreview.generation.publicPrompt}
            </p>
          {/if}

          <div class="smrt-content-governance-panel__transparency-list" data-smrt-part="list">
            <div class="smrt-content-governance-panel__transparency-list-section" data-smrt-part="section">
              <div class="smrt-content-governance-panel__section-caption" data-smrt-part="caption">{t(M['content.governance_panel.facts_used_in_article'])}</div>
              {#if transparencyPreview.factsUsed.length === 0}
                <p class="smrt-content-governance-panel__empty-copy" data-smrt-part="empty">{t(M['content.governance_panel.no_used_facts_public'])}</p>
              {:else}
                {#each transparencyPreview.factsUsed.slice(0, 3) as fact (fact.id ?? fact.textRefined ?? fact.textRaw)}
                  <div class="smrt-content-governance-panel__transparency-list-item" data-smrt-part="item">
                    <strong>{fact.textRefined || fact.textRaw || fact.id}</strong>
                    <span>
                      {fact.relationship || 'linked'}
                      {#if fact.sources && fact.sources.length > 0}
                        · {fact.sources.length} source(s)
                      {/if}
                    </span>
                  </div>
                {/each}
              {/if}
            </div>

            <div class="smrt-content-governance-panel__transparency-list-section" data-smrt-part="section">
              <div class="smrt-content-governance-panel__section-caption" data-smrt-part="caption">{t(M['content.governance_panel.source_material'])}</div>
              {#if transparencyPreview.references.length === 0}
                <p class="smrt-content-governance-panel__empty-copy" data-smrt-part="empty">{t(M['content.governance_panel.no_references_public'])}</p>
              {:else}
                {#each transparencyPreview.references.slice(0, 3) as reference (reference.id ?? reference.url ?? reference.title)}
                  <div class="smrt-content-governance-panel__transparency-list-item" data-smrt-part="item">
                    <strong>{getTransparencyReferenceLabel(reference)}</strong>
                    <span>
                      {t(M['content.governance_panel.reference_fact_counts'], { used: reference.usedFactIds.length, extracted: reference.extractedFacts.length })}
                    </span>
                  </div>
                {/each}
              {/if}
            </div>
          </div>
        </div>

        <div class="smrt-content-governance-panel__transparency-card" data-smrt-part="panel">
          <div class="smrt-content-governance-panel__transparency-card-header" data-smrt-part="header">
            <strong>{t(M['content.governance_panel.latest_published_snapshot'])}</strong>
            {#if publishedTransparency?.publicationVersion?.version !== null && publishedTransparency?.publicationVersion?.version !== undefined}
              <span class="smrt-content-governance-panel__pill smrt-content-governance-panel__pill--passed" data-smrt-part="badge">v{publishedTransparency.publicationVersion.version}</span>
            {/if}
          </div>

          {#if publishedTransparency}
            <span>
              Published {formatTimestamp(publishedTransparency.publicationVersion?.createdAt || publishedTransparency.generatedAt)}
            </span>
            <span>
              {t(M['content.governance_panel.timeline_and_corrections'], { events: publishedTransparency.versionHistory.length, corrections: publishedTransparency.corrections.length })}
            </span>
          {:else}
            <p class="smrt-content-governance-panel__empty-copy" data-smrt-part="empty">
              {t(M['content.governance_panel.no_published_snapshot'])}
            </p>
          {/if}
        </div>
      </div>
    {/if}
  </div>
    </details>
  {/if}

  {#if savedContentId && isSectionVisible('corrections')}
      <details class="smrt-content-governance-panel__drawer" data-smrt-part="drawer">
        <summary class="smrt-content-governance-panel__drawer-header" data-smrt-part="drawer-header">
          <div style="display: flex; align-items: center; gap: 0.5rem;">
            Corrections
          </div>
          <svg class="smrt-content-governance-panel__drawer-icon" data-smrt-part="icon" viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
        </summary>
        <div class="smrt-content-governance-panel__drawer-body" data-smrt-part="drawer-body">

        <label class="smrt-content-governance-panel__workflow-field" data-smrt-part="field">
          Summary
          <Input
            type="text"
            bind:value={correctionSummary}
            placeholder={t(M['content.governance_panel.what_was_wrong'])}
          />
        </label>

        <label class="smrt-content-governance-panel__workflow-field" data-smrt-part="field">
          {t(M['content.governance_panel.related_fact'])}
          <Select bind:value={correctionFactId}>
            <option value="">{t(M['content.governance_panel.general_correction'])}</option>
            {#each selectedFactsResolved as fact (fact.id)}
              <option value={fact.id ?? ''}>{fact.textRefined}</option>
            {/each}
          </Select>
        </label>

        <label class="smrt-content-governance-panel__workflow-field" data-smrt-part="field">
          {t(M['content.governance_panel.corrected_fact_text'])}
          <Textarea
            rows={4}
            bind:value={correctedFactText}
            placeholder={t(M['content.governance_panel.provide_corrected_wording'])}
          ></Textarea>
        </label>

        <label class="smrt-content-governance-panel__workflow-field" data-smrt-part="field">
          {t(M['content.governance_panel.public_note'])}
          <Textarea
            rows={3}
            bind:value={correctionPublicNote}
            placeholder={t(M['content.governance_panel.optional_public_correction_note'])}
          ></Textarea>
        </label>

        <label class="smrt-content-governance-panel__checkbox-row" data-smrt-part="field">
          <!-- raw-primitive-allow: native checkbox; no Provider-free checkbox primitive (Toggle is a switch with different semantics, CheckboxInput requires a Provider) -->
          <input type="checkbox" bind:checked={publishCorrection} />
          {t(M['content.governance_panel.publish_immediately'])}
        </label>

        <Button
          variant="primary"
          type="button"
          disabled={correctionBusy || correctionSummary.trim().length === 0}
          onclick={() => void issueCorrection()}
        >
          {correctionBusy ? 'Issuing correction...' : 'Issue Correction'}
        </Button>

        <div class="smrt-content-governance-panel__review-list" data-smrt-part="list">
          <div class="smrt-content-governance-panel__section-caption" data-smrt-part="caption">{t(M['content.governance_panel.published_history'])}</div>
          {#if corrections.length === 0}
            <p class="smrt-content-governance-panel__empty-copy" data-smrt-part="empty">{t(M['content.governance_panel.no_corrections_issued'])}</p>
          {:else}
            {#each corrections as correction (correction.id ?? `${correction.correctionType}-${correction.createdAt}`)}
              <div class="smrt-content-governance-panel__review-card" data-smrt-part="item">
                <div class="smrt-content-governance-panel__review-card-header" data-smrt-part="header">
                  <strong>{correction.correctionType}</strong>
                  <span class={`smrt-content-governance-panel__pill smrt-content-governance-panel__pill--${correction.status}`} data-smrt-part="badge">{correction.status}</span>
                </div>
                <p>{correction.summary}</p>
                <span>{formatTimestamp(correction.publishedAt)}</span>
                {#if getCorrectionProvenanceCopy(correction)}
                  <span>{getCorrectionProvenanceCopy(correction)}</span>
                {/if}
              </div>
            {/each}
          {/if}
        </div>
        </div>
      </details>
  {/if}

  {#if savedContentId && isSectionVisible('versions')}
      <details class="smrt-content-governance-panel__drawer" data-smrt-part="drawer">
        <summary class="smrt-content-governance-panel__drawer-header" data-smrt-part="drawer-header">
          <div style="display: flex; align-items: center; justify-content: space-between; flex: 1;">
            <div style="display: flex; align-items: center; gap: 0.5rem;">
              Versions
            </div>
            <Button
              variant="secondary"
              type="button"
              disabled={versionBusy}
              onclick={(e) => { e.preventDefault(); void createSnapshot(); }}
            >
              {versionBusy ? 'Working...' : 'Create Snapshot'}
            </Button>
          </div>
          <svg class="smrt-content-governance-panel__drawer-icon" data-smrt-part="icon" style="margin-left: 1rem;" viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
        </summary>
        <div class="smrt-content-governance-panel__drawer-body" data-smrt-part="drawer-body">

        {#if versions.length === 0}
          <p class="smrt-content-governance-panel__empty-copy" data-smrt-part="empty">{t(M['content.governance_panel.no_versions_saved'])}</p>
        {:else}
          <div class="smrt-content-governance-panel__review-list" data-smrt-part="list">
            {#each versions as version (version.id ?? `version-${version.version ?? 0}`)}
              <div class="smrt-content-governance-panel__review-card" data-smrt-part="item">
                <div class="smrt-content-governance-panel__review-card-header" data-smrt-part="header">
                  <strong>v{version.version}</strong>
                  <span class="smrt-content-governance-panel__pill smrt-content-governance-panel__pill--neutral" data-smrt-part="badge">{version.kind}</span>
                </div>
                <p>{version.summary || 'Snapshot saved'}</p>
                {#if getVersionProvenanceCopy(version)}
                  <span>{getVersionProvenanceCopy(version)}</span>
                {/if}
                <div class="smrt-content-governance-panel__version-card-footer" data-smrt-part="footer">
                  <span>{formatTimestamp(version.createdAt)}</span>
                  <Button
                    variant="secondary"
                    type="button"
                    disabled={versionBusy || version.version === null || version.version === undefined}
                    onclick={() => {
                      if (
                        version.version !== null &&
                        version.version !== undefined
                      ) {
                        requestRestoreVersion(version.version);
                      }
                    }}
                  >
                    Restore
                  </Button>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </details>
  {/if}
</div>

<ConfirmDialog
  open={pendingRestoreVersion !== null}
  title={t(M['content.governance_panel.restore_confirm_title'])}
  message={t(M['content.governance_panel.restore_confirm_message'], {
    version: pendingRestoreVersion ?? '',
  })}
  confirmLabel={t(M['content.governance_panel.restore_confirm_action'])}
  cancelLabel={t(M['content.governance_panel.restore_confirm_cancel'])}
  onconfirm={confirmRestoreVersion}
  oncancel={cancelRestoreVersion}
/>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-content-governance-panel__drawer {
    margin: 0 0 2rem 0;
    padding: 0;
  }
  .smrt-content-governance-panel__drawer-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0 0 1.25rem 0;
    cursor: pointer;
    list-style: none;
    /* Hide default triangle */
    user-select: none;
    margin: 0;
  }
  /* Hide the default details marker */
  .smrt-content-governance-panel__drawer-header::-webkit-details-marker {
    display: none;
  }
  .smrt-content-governance-panel__drawer-body {
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }
  .smrt-content-governance-panel__root {
    container-type: inline-size;
    container-name: governance-panel;
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }
  .smrt-content-governance-panel__workflow-grid {
    display: grid;
    gap: 1.25rem;
  }
  @container governance-panel (min-width: 56rem) {
    .smrt-content-governance-panel__workflow-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  .smrt-content-governance-panel__workflow-section {
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
  }
  .smrt-content-governance-panel__workflow-section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }
  .smrt-content-governance-panel__workflow-field-group {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .smrt-content-governance-panel__fact-search,
  .smrt-content-governance-panel__fact-pagination,
  .smrt-content-governance-panel__fact-pagination-actions,
  .smrt-content-governance-panel__claim-audit-toolbar,
  .smrt-content-governance-panel__claim-audit-counts,
  .smrt-content-governance-panel__review-actions,
  .smrt-content-governance-panel__version-card-footer {
    display: flex;
    gap: 0.75rem;
    align-items: center;
  }
  .smrt-content-governance-panel__fact-pagination {
    justify-content: space-between;
    flex-wrap: wrap;
  }
  .smrt-content-governance-panel__workflow-field {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .smrt-content-governance-panel__fact-chip-list,
  .smrt-content-governance-panel__fact-catalog-list,
  .smrt-content-governance-panel__claim-audit-group,
  .smrt-content-governance-panel__claim-audit-item-body,
  .smrt-content-governance-panel__claim-audit-evidence,
  .smrt-content-governance-panel__claim-audit-match,
  .smrt-content-governance-panel__review-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .smrt-content-governance-panel__claim-audit-toolbar {
    justify-content: space-between;
    flex-wrap: wrap;
  }
  .smrt-content-governance-panel__claim-audit-counts {
    flex-wrap: wrap;
  }
  .smrt-content-governance-panel__claim-audit-warnings {
    padding: 0.75rem 0.9rem;
  }
  .smrt-content-governance-panel__claim-audit-warnings p,
  .smrt-content-governance-panel__claim-audit-item p {
    margin: 0;
  }
  .smrt-content-governance-panel__claim-audit-item {
    padding: 0.75rem;
  }
  .smrt-content-governance-panel__claim-audit-item summary {
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }
  .smrt-content-governance-panel__claim-audit-item-body {
    padding-top: 0.75rem;
  }
  .smrt-content-governance-panel__claim-audit-select {
    display: inline-flex;
  }
  .smrt-content-governance-panel__claim-audit-item-actions {
    display: flex;
    justify-content: flex-end;
  }
  .smrt-content-governance-panel__review-profile-list {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .smrt-content-governance-panel__fact-chip,
  .smrt-content-governance-panel__fact-result,
  .smrt-content-governance-panel__review-card {
    padding: 0.85rem;
  }
  .smrt-content-governance-panel__fact-chip,
  .smrt-content-governance-panel__fact-result,
  .smrt-content-governance-panel__review-card-header,
  .smrt-content-governance-panel__version-card-footer {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .smrt-content-governance-panel__fact-chip-body,
  .smrt-content-governance-panel__fact-result-body {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .smrt-content-governance-panel__fact-chip :global(.fact-chip__remove) {
    padding: 0;
  }
  .smrt-content-governance-panel__review-card {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .smrt-content-governance-panel__review-card-header {
    align-items: center;
  }
  .smrt-content-governance-panel__review-profile-card {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.85rem;
  }
  .smrt-content-governance-panel__review-profile-card-header,
  .smrt-content-governance-panel__review-profile-item,
  .smrt-content-governance-panel__review-profile-item-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .smrt-content-governance-panel__review-profile-card-badges {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  .smrt-content-governance-panel__review-profile-callout {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding: 0.75rem;
  }
  .smrt-content-governance-panel__review-profile-item {
    padding: 0.65rem 0.75rem;
  }
  .smrt-content-governance-panel__review-profile-item-body {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .smrt-content-governance-panel__review-findings {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .smrt-content-governance-panel__review-finding {
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
  }
  .smrt-content-governance-panel__review-finding-body {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .smrt-content-governance-panel__transparency-grid {
    display: grid;
    gap: 1rem;
  }
  @container governance-panel (min-width: 56rem) {
    .smrt-content-governance-panel__transparency-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
  .smrt-content-governance-panel__transparency-stats {
    display: grid;
    gap: 0.75rem;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  }
  .smrt-content-governance-panel__transparency-stat {
    padding: 0.8rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .smrt-content-governance-panel__transparency-card {
    padding: 0.9rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .smrt-content-governance-panel__transparency-card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .smrt-content-governance-panel__transparency-card-prompt {
    margin: 0;
    white-space: pre-wrap;
  }
  .smrt-content-governance-panel__transparency-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .smrt-content-governance-panel__transparency-list-section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .smrt-content-governance-panel__transparency-list-item {
    padding: 0.7rem 0.8rem;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .smrt-content-governance-panel__pill {
    padding: 0.2rem 0.55rem;
  }
  .smrt-content-governance-panel__checkbox-row {
    display: flex;
    align-items: center;
    gap: 0.55rem;
  }
  .smrt-content-governance-panel__workflow-error,
  .smrt-content-governance-panel__workflow-notice {
    margin: 0;
    padding: 0.75rem 0.9rem;
  }
}

@layer smrt.theme {
  .smrt-content-governance-panel__drawer-header {
    font-size: var(--smrt-typography-headline-small-size, 1.5rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
    color: var(--smrt-color-on-surface);
    transition: color 0.2s;
  }
  .smrt-content-governance-panel__drawer-header:hover {
    color: var(--smrt-color-primary);
  }
  .smrt-content-governance-panel__drawer-icon {
    color: var(--smrt-color-outline);
    transition: transform 0.3s ease;
  }
  .smrt-content-governance-panel__drawer[open] .smrt-content-governance-panel__drawer-icon {
    transform: rotate(180deg);
  }
  .smrt-content-governance-panel__workflow-section {
    background: var(--smrt-color-surface-container-low);
    border: var(--smrt-hairline);
    border-radius: 0.75rem;
  }
  .smrt-content-governance-panel__section-status,
  .smrt-content-governance-panel__section-caption,
  .smrt-content-governance-panel__empty-copy,
  .smrt-content-governance-panel__claim-audit-help,
  .smrt-content-governance-panel__review-card span,
  .smrt-content-governance-panel__claim-audit-counts,
  .smrt-content-governance-panel__claim-audit-item span,
  .smrt-content-governance-panel__fact-result span,
  .smrt-content-governance-panel__fact-chip span {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-medium-size, 0.85rem);
  }
  .smrt-content-governance-panel__fact-pagination {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-medium-size, 0.85rem);
  }
  .smrt-content-governance-panel__workflow-field {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
  }
  .smrt-content-governance-panel__claim-audit-warnings {
    border-radius: 0.6rem;
    background: color-mix(in srgb, var(--smrt-color-warning) 12%, transparent);
    color: var(--smrt-color-on-warning-container);
  }
  .smrt-content-governance-panel__claim-audit-item {
    border: var(--smrt-hairline);
    border-radius: 0.6rem;
    background: var(--smrt-color-surface);
  }
  .smrt-content-governance-panel__claim-audit-select {
    line-height: 1;
  }
  .smrt-content-governance-panel__fact-chip,
  .smrt-content-governance-panel__fact-result,
  .smrt-content-governance-panel__review-card {
    background: var(--smrt-color-surface);
    border: var(--smrt-hairline);
    border-radius: 0.75rem;
  }
  .smrt-content-governance-panel__fact-chip :global(.fact-chip__remove) {
    background: transparent;
    color: var(--smrt-color-error);
  }
  .smrt-content-governance-panel__fact-chip :global(.fact-chip__remove:hover:not(:disabled):not(.disabled)) {
    background: transparent;
  }
  .smrt-content-governance-panel__review-profile-card {
    background: var(--smrt-color-surface);
    border: var(--smrt-hairline);
    border-radius: 0.75rem;
  }
  .smrt-content-governance-panel__review-profile-callout {
    border-radius: 0.65rem;
    border: 1px solid color-mix(in srgb, var(--smrt-color-warning) 28%, transparent);
    background: color-mix(in srgb, var(--smrt-color-warning) 10%, transparent);
  }
  .smrt-content-governance-panel__review-profile-item {
    border: var(--smrt-hairline);
    border-radius: 0.65rem;
    background: var(--smrt-color-surface-container-low);
  }
  .smrt-content-governance-panel__transparency-stat,
  .smrt-content-governance-panel__transparency-card,
  .smrt-content-governance-panel__transparency-list-item {
    background: var(--smrt-color-surface);
    border: var(--smrt-hairline);
    border-radius: 0.75rem;
  }
  .smrt-content-governance-panel__transparency-card-prompt {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-content-governance-panel__pill {
    border-radius: var(--smrt-radius-full);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
    text-transform: capitalize;
  }
  .smrt-content-governance-panel__pill--passed {
    background: color-mix(in srgb, var(--smrt-color-success) 14%, transparent);
    color: var(--smrt-color-on-success-container);
  }
  .smrt-content-governance-panel__pill--flagged {
    background: color-mix(in srgb, var(--smrt-color-warning) 16%, transparent);
    color: var(--smrt-color-on-warning-container);
  }
  .smrt-content-governance-panel__pill--failed,
  .smrt-content-governance-panel__pill--draft,
  .smrt-content-governance-panel__pill--retracted {
    background: color-mix(in srgb, var(--smrt-color-error) 14%, transparent);
    color: var(--smrt-color-on-error-container);
  }
  .smrt-content-governance-panel__pill--published,
  .smrt-content-governance-panel__pill--neutral {
    background: color-mix(in srgb, var(--smrt-color-primary) 14%, transparent);
    color: var(--smrt-color-on-primary-container);
  }
  .smrt-content-governance-panel__checkbox-row {
    color: var(--smrt-color-on-surface);
  }
  .smrt-content-governance-panel__workflow-error,
  .smrt-content-governance-panel__workflow-notice {
    border-radius: 0.6rem;
    font-size: var(--smrt-typography-body-medium-size, 0.9rem);
  }
  .smrt-content-governance-panel__workflow-error {
    background: color-mix(in srgb, var(--smrt-color-error) 10%, transparent);
    color: var(--smrt-color-on-error-container);
  }
  .smrt-content-governance-panel__workflow-notice {
    background: color-mix(in srgb, var(--smrt-color-primary) 10%, transparent);
    color: var(--smrt-color-on-primary-container);
  }
}

</style>
