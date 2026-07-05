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
  apiBaseUrl?: string;
  contentId?: string;
  draftType?: string | null;
  draftVariant?: string | null;
  selectedFactIds?: string[];
  selectedFacts?: FactData[];
  defaultRelationship?: string;
  reviewProfileKey?: string;
  customReviewLabel?: string;
  customReviewInstructions?: string;
  customReviewPolicyKey?: string;
  showFactCatalog?: boolean;
  onFactsChange?: (factIds: string[], facts: FactData[]) => void;
  onGovernanceStateChange?: (state: ContentGovernanceStateData | null) => void;
  onFactAuditChange?: (state: FactAuditStateData | null) => void;
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

<div class="factual-workflow">
  {#if isSectionVisible('factAudit')}
    <details class="editor-drawer" open={(factAudit?.counts.total ?? 0) > 0}>
    <summary class="editor-drawer-header">
      <div style="display: flex; align-items: center; gap: 0.5rem;">
        {t(M['content.governance_panel.article_claim_audit'])}
        {#if factAuditBusy}
          <span class="section-status" style="font-size: 0.875rem; font-weight: 400; color: var(--smrt-color-outline);">Repairing...</span>
        {/if}
      </div>
      <svg class="drawer-icon" viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
    </summary>
    <div class="editor-drawer-content">
      {#if !savedContentId}
        <p class="empty-copy">{t(M['content.governance_panel.save_to_audit_claims'])}</p>
      {:else}
        <div class="claim-audit-toolbar">
          <div class="claim-audit-counts">
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
        <p class="claim-audit-help">
          {t(M['content.governance_panel.article_claims_help'])}
        </p>

        {#if actionableFactAuditWarnings.length}
          <div class="claim-audit-warnings">
            {#each actionableFactAuditWarnings as warning}
              <p>{warning}</p>
            {/each}
          </div>
        {/if}

        {#if !factAudit || factAudit.counts.total === 0}
          <p class="empty-copy">
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
              <div class="claim-audit-group">
                <div class="section-caption">{t(M['content.governance_panel.group_article_claims'], { group: group[1] })}</div>
                {#each groupClaims as claim (claim.id ?? claim.claimQuote ?? claim.fact.textRefined)}
                  <details class="claim-audit-item">
                    <summary>
                      <label class="claim-audit-select">
                        <!-- raw-primitive-allow: native checkbox; no Provider-free checkbox primitive (Toggle is a switch with different semantics, CheckboxInput requires a Provider) -->
                        <input
                          type="checkbox"
                          checked={isClaimSelected(claim)}
                          disabled={!getClaimId(claim)}
                          onchange={() => toggleClaimSelection(claim)}
                        />
                      </label>
                      <span class={`pill pill--${claim.supportStatus === 'supported' ? 'passed' : claim.supportStatus === 'contradicted' ? 'failed' : 'flagged'}`}>
                        {claim.supportStatus.replace('_', ' ')}
                      </span>
                      <strong>{claim.fact.textRefined || claim.claimQuote || claim.id}</strong>
                    </summary>
                    <div class="claim-audit-item__body">
                      <div class="claim-audit-item__actions">
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
                        <div class="claim-audit-evidence">
                          <div class="section-caption">{t(M['content.governance_panel.claim_excerpt'])}</div>
                          {#each claim.evidence as evidence (evidence.id ?? evidence.evidenceKey)}
                            <p>{evidence.quote || evidence.locator || evidence.sourceTitle}</p>
                          {/each}
                        </div>
                      {/if}
                      {#if claim.matchedFacts?.length}
                        <div class="claim-audit-evidence">
                          <div class="section-caption">{t(M['content.governance_panel.based_on_source_evidence'])}</div>
                          {#each claim.matchedFacts as matched (matched.fact.id ?? matched.fact.textRefined)}
                            <div class="claim-audit-match">
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
    <details class="editor-drawer" open={selectedFactsResolved.length > 0}>
      <summary class="editor-drawer-header">
        <div style="display: flex; align-items: center; gap: 0.5rem;">
          {t(M['content.governance_panel.manual_fact_links'])}
          {#if syncingFacts}
            <span class="section-status" style="font-size: 0.875rem; font-weight: 400; color: var(--smrt-color-outline);">{t(M['content.governance_panel.saving_links'])}</span>
          {/if}
        </div>
        <svg class="drawer-icon" viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
      </summary>
      <div class="editor-drawer-content">
        {#if governanceState && !governanceState.factLinkingEnabled}
          <p class="empty-copy">
            {t(M['content.governance_panel.fact_linking_not_enabled'])}
          </p>
        {:else}
          <div class="selected-facts">
            <div class="section-caption">{t(M['content.governance_panel.manually_linked_facts'])}</div>
            {#if selectedFactsResolved.length === 0}
              <p class="empty-copy">{t(M['content.governance_panel.no_manually_linked_facts'])}</p>
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
            <div class="fact-search">
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
              <p class="workflow-error" role="alert" aria-live="assertive">{catalogError}</p>
            {/if}

            <div class="fact-catalog">
              <div class="section-caption">{t(M['content.governance_panel.fact_catalog'])}</div>
              {#if catalogLoading}
                <p class="empty-copy">{t(M['content.governance_panel.loading_facts'])}</p>
              {:else if catalogFacts.length === 0}
                <p class="empty-copy">{t(M['content.governance_panel.no_facts_matched'])}</p>
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
                <div class="fact-pagination" aria-label={t(M['content.governance_panel.fact_catalog_pagination'])}>
                  <span>
                    Page {catalogPage}
                    {#if catalogFacts.length > 0}
                      · {factCatalogRangeStart}-{factCatalogRangeEnd}
                    {/if}
                  </span>
                  <div class="fact-pagination__actions">
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
    <details class="editor-drawer">
    <summary class="editor-drawer-header">
      <div style="display: flex; align-items: center; gap: 0.5rem;">
        Review
        {#if workflowLoading}
          <span class="section-status" style="font-size: 0.875rem; font-weight: 400; color: var(--smrt-color-outline);">Loading...</span>
        {/if}
      </div>
      <svg class="drawer-icon" viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
    </summary>
    <div class="editor-drawer-content">

    {#if workflowError}
      <p class="workflow-error" role="alert" aria-live="assertive">{workflowError}</p>
    {/if}

    {#if workflowNotice}
      <p class="workflow-notice" role="status" aria-live="polite">{workflowNotice}</p>
    {/if}

    {#if !savedContentId}
      <p class="empty-copy">
        {t(M['content.governance_panel.save_to_run_governance'])}
      </p>
    {:else}
      {#if reviewProfiles.length > 0}
        <label class="workflow-field">
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

          {#if activeUnsatisfiedRequirements.length > 0}
            <div class="review-profile-callout">
              <strong>{t(M['content.governance_panel.needs_attention'])}</strong>
              <span>
                {t(M['content.governance_panel.requirements_need_attention'], { count: activeUnsatisfiedRequirements.length })}
              </span>
            </div>
          {/if}

          {#if activeReviewProfile.requirements?.length === 0}
            <p class="empty-copy">{t(M['content.governance_panel.no_review_requirements'])}</p>
          {:else}
            <div class="review-profile-list">
              {#each activeReviewProfile.requirements as requirement (requirement.policyKey)}
                <div class="review-profile-item">
                  <div class="review-profile-item__body">
                    <strong>{requirement.label}</strong>
                    <span>{getRequirementStateCopy(requirement)}</span>
                  </div>
                  <div class="review-profile-item__meta">
                    {#if requirement.blocking}
                      <span class="pill pill--neutral">Blocking</span>
                    {/if}
                    <span class={`pill pill--${getRequirementStateTone(requirement)}`}>
                      {getRequirementStateLabel(requirement)}
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

      <div class="workflow-field-group">
        {#if availableCustomPolicies.length > 0}
          <label class="workflow-field">
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

        <label class="workflow-field">
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

      <div class="review-list">
        <div class="section-caption">{t(M['content.governance_panel.recent_reviews'])}</div>
        {#if reviews.length === 0}
          <p class="empty-copy">{t(M['content.governance_panel.no_reviews_run'])}</p>
        {:else}
          {#each reviews as review (review.id ?? `${review.kind}-${review.createdAt}`)}
            <div class="review-card">
              <div class="review-card__header">
                <strong>{review.policyKey || review.kind}</strong>
                <span class={`pill pill--${getReviewTone(review)}`}>
                  {review.status || 'pending'}
                </span>
              </div>
              <p>{review.summary || 'Review completed.'}</p>
              {#if review.findings && review.findings.length > 0}
                <div class="review-findings">
                  {#each review.findings.slice(0, 2) as finding (`${review.id}-${finding.title ?? finding.detail}`)}
                    <div class="review-finding">
                      <span class={`pill pill--${getFindingTone(finding.severity)}`}>
                        {finding.severity || 'warning'}
                      </span>
                      <div class="review-finding__body">
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
    <details class="editor-drawer">
    <summary class="editor-drawer-header">
      <div style="display: flex; align-items: center; gap: 0.5rem;">
        Transparency
        {#if transparencyLoading}
          <span class="section-status" style="font-size: 0.875rem; font-weight: 400; color: var(--smrt-color-outline);">Loading...</span>
        {/if}
      </div>
      <svg class="drawer-icon" viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
    </summary>
    <div class="editor-drawer-content">

    {#if !savedContentId}
      <p class="empty-copy">
        {t(M['content.governance_panel.save_to_preview_transparency'])}
      </p>
    {:else if governanceState && !governanceState.transparencyEnabled}
      <p class="empty-copy">
        {t(M['content.governance_panel.transparency_snapshots_not_enabled'])}
      </p>
    {:else if !transparencyPreview}
      <p class="empty-copy">{t(M['content.governance_panel.no_transparency_preview'])}</p>
    {:else}
      <p class="section-caption">
        {t(M['content.governance_panel.transparency_preview_explainer'])}
      </p>

      <div class="transparency-stats">
        <div class="transparency-stat">
          <strong>{transparencyPreview.factsUsed.length}</strong>
          <span>{t(M['content.governance_panel.facts_used'])}</span>
        </div>
        <div class="transparency-stat">
          <strong>{transparencyPreview.references.length}</strong>
          <span>References</span>
        </div>
        <div class="transparency-stat">
          <strong>{transparencyPreview.otherExtractedFacts.length}</strong>
          <span>{t(M['content.governance_panel.other_extracted_facts'])}</span>
        </div>
        <div class="transparency-stat">
          <strong>{transparencyPreview.corrections.length}</strong>
          <span>{t(M['content.governance_panel.public_corrections'])}</span>
        </div>
      </div>

      <div class="transparency-grid">
        <div class="transparency-card">
          <div class="transparency-card__header">
            <strong>{t(M['content.governance_panel.current_preview'])}</strong>
            <span class="pill pill--neutral">{transparencyPreview.snapshotKind}</span>
          </div>
          <span>
            {#if transparencyPreview.generation.publicPrompt}
              {t(M['content.governance_panel.public_prompt_set'])}
            {:else}
              {t(M['content.governance_panel.no_public_prompt_exposed'])}
            {/if}
          </span>
          {#if transparencyPreview.generation.publicPrompt}
            <p class="transparency-card__prompt">
              {transparencyPreview.generation.publicPrompt}
            </p>
          {/if}

          <div class="transparency-list">
            <div class="transparency-list__section">
              <div class="section-caption">{t(M['content.governance_panel.facts_used_in_article'])}</div>
              {#if transparencyPreview.factsUsed.length === 0}
                <p class="empty-copy">{t(M['content.governance_panel.no_used_facts_public'])}</p>
              {:else}
                {#each transparencyPreview.factsUsed.slice(0, 3) as fact (fact.id ?? fact.textRefined ?? fact.textRaw)}
                  <div class="transparency-list__item">
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

            <div class="transparency-list__section">
              <div class="section-caption">{t(M['content.governance_panel.source_material'])}</div>
              {#if transparencyPreview.references.length === 0}
                <p class="empty-copy">{t(M['content.governance_panel.no_references_public'])}</p>
              {:else}
                {#each transparencyPreview.references.slice(0, 3) as reference (reference.id ?? reference.url ?? reference.title)}
                  <div class="transparency-list__item">
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

        <div class="transparency-card">
          <div class="transparency-card__header">
            <strong>{t(M['content.governance_panel.latest_published_snapshot'])}</strong>
            {#if publishedTransparency?.publicationVersion?.version !== null && publishedTransparency?.publicationVersion?.version !== undefined}
              <span class="pill pill--passed">v{publishedTransparency.publicationVersion.version}</span>
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
            <p class="empty-copy">
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
      <details class="editor-drawer">
        <summary class="editor-drawer-header">
          <div style="display: flex; align-items: center; gap: 0.5rem;">
            Corrections
          </div>
          <svg class="drawer-icon" viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
        </summary>
        <div class="editor-drawer-content">

        <label class="workflow-field">
          Summary
          <Input
            type="text"
            bind:value={correctionSummary}
            placeholder={t(M['content.governance_panel.what_was_wrong'])}
          />
        </label>

        <label class="workflow-field">
          {t(M['content.governance_panel.related_fact'])}
          <Select bind:value={correctionFactId}>
            <option value="">{t(M['content.governance_panel.general_correction'])}</option>
            {#each selectedFactsResolved as fact (fact.id)}
              <option value={fact.id ?? ''}>{fact.textRefined}</option>
            {/each}
          </Select>
        </label>

        <label class="workflow-field">
          {t(M['content.governance_panel.corrected_fact_text'])}
          <Textarea
            rows={4}
            bind:value={correctedFactText}
            placeholder={t(M['content.governance_panel.provide_corrected_wording'])}
          ></Textarea>
        </label>

        <label class="workflow-field">
          {t(M['content.governance_panel.public_note'])}
          <Textarea
            rows={3}
            bind:value={correctionPublicNote}
            placeholder={t(M['content.governance_panel.optional_public_correction_note'])}
          ></Textarea>
        </label>

        <label class="checkbox-row">
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

        <div class="review-list">
          <div class="section-caption">{t(M['content.governance_panel.published_history'])}</div>
          {#if corrections.length === 0}
            <p class="empty-copy">{t(M['content.governance_panel.no_corrections_issued'])}</p>
          {:else}
            {#each corrections as correction (correction.id ?? `${correction.correctionType}-${correction.createdAt}`)}
              <div class="review-card">
                <div class="review-card__header">
                  <strong>{correction.correctionType}</strong>
                  <span class={`pill pill--${correction.status}`}>{correction.status}</span>
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
      <details class="editor-drawer">
        <summary class="editor-drawer-header">
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
          <svg class="drawer-icon" style="margin-left: 1rem;" viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>
        </summary>
        <div class="editor-drawer-content">

        {#if versions.length === 0}
          <p class="empty-copy">{t(M['content.governance_panel.no_versions_saved'])}</p>
        {:else}
          <div class="review-list">
            {#each versions as version (version.id ?? `version-${version.version ?? 0}`)}
              <div class="review-card">
                <div class="review-card__header">
                  <strong>v{version.version}</strong>
                  <span class="pill pill--neutral">{version.kind}</span>
                </div>
                <p>{version.summary || 'Snapshot saved'}</p>
                {#if getVersionProvenanceCopy(version)}
                  <span>{getVersionProvenanceCopy(version)}</span>
                {/if}
                <div class="version-card__footer">
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
  .editor-drawer {
    margin: 0 0 2rem 0;
    padding: 0;
  }

  .editor-drawer-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0 0 1.25rem 0;
    font-size: var(--smrt-typography-headline-small-size, 1.5rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
    color: var(--smrt-color-on-surface);
    cursor: pointer;
    list-style: none; /* Hide default triangle */
    user-select: none;
    transition: color 0.2s;
    margin: 0;
  }
  
  /* Hide the default details marker */
  .editor-drawer-header::-webkit-details-marker {
    display: none;
  }

  .editor-drawer-header:hover {
    color: var(--smrt-color-primary);
  }

  .drawer-icon {
    color: var(--smrt-color-outline);
    transition: transform 0.3s ease;
  }

  .editor-drawer[open] .drawer-icon {
    transform: rotate(180deg);
  }

  .editor-drawer-content {
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

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

  .workflow-field-group {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .section-status,
  .section-caption,
  .empty-copy,
  .claim-audit-help,
  .review-card span,
  .claim-audit-counts,
  .claim-audit-item span,
  .fact-result span,
  .fact-chip span {
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-medium-size, 0.85rem);
  }

  .fact-search,
  .fact-pagination,
  .fact-pagination__actions,
  .claim-audit-toolbar,
  .claim-audit-counts,
  .review-actions,
  .version-card__footer {
    display: flex;
    gap: 0.75rem;
    align-items: center;
  }

  .fact-pagination {
    justify-content: space-between;
    flex-wrap: wrap;
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-medium-size, 0.85rem);
  }

  .workflow-field {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
  }

  .fact-chip-list,
  .fact-catalog__list,
  .claim-audit-group,
  .claim-audit-item__body,
  .claim-audit-evidence,
  .claim-audit-match,
  .review-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .claim-audit-toolbar {
    justify-content: space-between;
    flex-wrap: wrap;
  }

  .claim-audit-counts {
    flex-wrap: wrap;
  }

  .claim-audit-warnings {
    border-radius: 0.6rem;
    background: color-mix(in srgb, var(--smrt-color-warning) 12%, transparent);
    color: var(--smrt-color-on-warning-container);
    padding: 0.75rem 0.9rem;
  }

  .claim-audit-warnings p,
  .claim-audit-item p {
    margin: 0;
  }

  .claim-audit-item {
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 0.6rem;
    background: var(--smrt-color-surface);
    padding: 0.75rem;
  }

  .claim-audit-item summary {
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }

  .claim-audit-item__body {
    padding-top: 0.75rem;
  }

  .claim-audit-select {
    display: inline-flex;
    line-height: 1;
  }

  .claim-audit-item__actions {
    display: flex;
    justify-content: flex-end;
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

  .fact-chip :global(.fact-chip__remove) {
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

  .review-profile-callout {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    border-radius: 0.65rem;
    border: 1px solid color-mix(in srgb, var(--smrt-color-warning) 28%, transparent);
    background: color-mix(in srgb, var(--smrt-color-warning) 10%, transparent);
    padding: 0.75rem;
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

  .review-findings {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .review-finding {
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
  }

  .review-finding__body {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .transparency-grid {
    display: grid;
    gap: 1rem;
  }

  @media (min-width: 900px) {
    .transparency-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  .transparency-stats {
    display: grid;
    gap: 0.75rem;
    grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  }

  .transparency-stat,
  .transparency-card,
  .transparency-list__item {
    background: var(--smrt-color-surface);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 0.75rem;
  }

  .transparency-stat {
    padding: 0.8rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .transparency-card {
    padding: 0.9rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .transparency-card__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .transparency-card__prompt {
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
    white-space: pre-wrap;
  }

  .transparency-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .transparency-list__section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .transparency-list__item {
    padding: 0.7rem 0.8rem;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .pill {
    border-radius: var(--smrt-radius-full, 9999px);
    padding: 0.2rem 0.55rem;
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
    text-transform: capitalize;
  }

  .pill--passed {
    background: color-mix(in srgb, var(--smrt-color-success) 14%, transparent);
    color: var(--smrt-color-on-success-container);
  }

  .pill--flagged {
    background: color-mix(in srgb, var(--smrt-color-warning) 16%, transparent);
    color: var(--smrt-color-on-warning-container);
  }

  .pill--failed,
  .pill--draft,
  .pill--retracted {
    background: color-mix(in srgb, var(--smrt-color-error) 14%, transparent);
    color: var(--smrt-color-on-error-container);
  }

  .pill--published,
  .pill--neutral {
    background: color-mix(in srgb, var(--smrt-color-primary) 14%, transparent);
    color: var(--smrt-color-on-primary-container);
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
    font-size: var(--smrt-typography-body-medium-size, 0.9rem);
  }

  .workflow-error {
    background: color-mix(in srgb, var(--smrt-color-error) 10%, transparent);
    color: var(--smrt-color-on-error-container);
  }

  .workflow-notice {
    background: color-mix(in srgb, var(--smrt-color-primary) 10%, transparent);
    color: var(--smrt-color-on-primary-container);
  }
</style>
