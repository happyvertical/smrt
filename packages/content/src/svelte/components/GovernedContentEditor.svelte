<script lang="ts">
import type {
  ContentData,
  ContentGovernanceStateData,
  FactData,
} from '../../mock-smrt-client';
import { evaluateContentPublishReadiness } from '../../publish-readiness';
import ContentEditor from './ContentEditor.svelte';
import ContentGovernancePanel from './ContentGovernancePanel.svelte';

export type GovernedContentEditorSaveData = ContentData & {
  factIds: string[];
  facts: FactData[];
};

export interface Props {
  content?: ContentData;
  contentId?: string;
  defaultRelationship?: string;
  reviewProfileKey?: string;
  customReviewLabel?: string;
  customReviewInstructions?: string;
  customReviewPolicyKey?: string;
  enforcePublishReadiness?: boolean;
  onSave: (data: GovernedContentEditorSaveData) => void;
  onCancel: () => void;
}

let {
  content = undefined,
  contentId = 'new',
  defaultRelationship = 'supports',
  reviewProfileKey = 'publication',
  customReviewLabel = 'Custom Review',
  customReviewInstructions = '',
  customReviewPolicyKey = 'custom',
  enforcePublishReadiness = false,
  onSave,
  onCancel,
}: Props = $props();

function getInitialSelectedFactIds(nextContent?: ContentData) {
  return Array.isArray(nextContent?.factIds)
    ? nextContent.factIds.filter((factId): factId is string => Boolean(factId))
    : [];
}

function getInitialSelectedFacts(nextContent?: ContentData) {
  return Array.isArray(nextContent?.facts) ? nextContent.facts : [];
}

let selectedFactIds = $state<string[]>([]);
let selectedFacts = $state<FactData[]>([]);
let lastResetKey = $state<string | null | undefined>(undefined);
let draftContent = $state<ContentData | undefined>(undefined);
let governanceState = $state<ContentGovernanceStateData | null>(null);
const resolvedContentId = $derived(content?.id ?? contentId);

$effect(() => {
  const nextResetKey = content?.id ?? contentId ?? null;
  if (nextResetKey === lastResetKey) {
    return;
  }

  lastResetKey = nextResetKey;
  selectedFactIds = getInitialSelectedFactIds(content);
  selectedFacts = getInitialSelectedFacts(content);
  draftContent = content;
  governanceState = null;
});

const governedContent = $derived(
  content
    ? {
        ...content,
        factIds: selectedFactIds,
        facts: selectedFacts,
      }
    : undefined,
);
const activeReviewProfileKey = $derived(
  governanceState?.publicationProfileKey || reviewProfileKey,
);
const activeEnforcePublishReadiness = $derived(
  governanceState?.enforcePublishReadiness ?? enforcePublishReadiness,
);
const publishReadinessState = $derived(
  evaluateContentPublishReadiness({
    status: draftContent?.status || governedContent?.status,
    contentId:
      typeof resolvedContentId === 'string' && resolvedContentId !== 'new'
        ? resolvedContentId
        : null,
    reviewProfileKey: activeReviewProfileKey,
    reviewProfiles: governanceState?.reviewProfiles || [],
    enforce: activeEnforcePublishReadiness,
  }),
);
const publishSaveNotice = $derived(
  publishReadinessState &&
    publishReadinessState.level !== 'ready' &&
    publishReadinessState.message
    ? publishReadinessState.message
    : null,
);
const publishSaveDisabled = $derived(
  Boolean(publishReadinessState?.disableSave),
);

function handleFactsChange(factIds: string[], facts: FactData[]) {
  selectedFactIds = factIds;
  selectedFacts = facts;
}

function handleEditorChange(data: ContentData) {
  draftContent = data;
}

function handleGovernanceStateChange(state: ContentGovernanceStateData | null) {
  governanceState = state;
}

function handleSave(data: ContentData) {
  draftContent = data;

  if (publishReadinessState?.disableSave) {
    return;
  }

  onSave({
    ...data,
    factIds: selectedFactIds,
    facts: selectedFacts,
  });
}
</script>

<div class="governed-editor">
  {#if publishReadinessState}
    <div class={`publish-readiness-card publish-readiness-card--${publishReadinessState.level}`}>
      <div class="publish-readiness-card__header">
        <strong>{publishReadinessState.title}</strong>
        <span class="publish-readiness-card__profile">
          {activeReviewProfileKey}
        </span>
      </div>
      <p>{publishReadinessState.message}</p>
      {#if publishReadinessState.details.length > 0}
        <ul class="publish-readiness-card__list">
          {#each publishReadinessState.details as detail}
            <li>{detail}</li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}

  <ContentEditor
    content={governedContent}
    contentId={resolvedContentId}
    saveDisabled={publishSaveDisabled}
    saveNotice={publishSaveNotice}
    onChange={handleEditorChange}
    onSave={handleSave}
    onCancel={onCancel}
  />

  <ContentGovernancePanel
    contentId={resolvedContentId}
    draftType={draftContent?.type || content?.type}
    draftVariant={draftContent?.variant || content?.variant}
    selectedFactIds={selectedFactIds}
    selectedFacts={selectedFacts}
    defaultRelationship={defaultRelationship}
    reviewProfileKey={activeReviewProfileKey}
    customReviewLabel={customReviewLabel}
    customReviewInstructions={customReviewInstructions}
    customReviewPolicyKey={customReviewPolicyKey}
    onFactsChange={handleFactsChange}
    onGovernanceStateChange={handleGovernanceStateChange}
  />
</div>

<style>
  .governed-editor {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }

  .publish-readiness-card {
    border-radius: 0.75rem;
    padding: 1rem;
    border: 1px solid var(--smrt-color-outline-variant);
    background: var(--smrt-color-surface-container-low);
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
  }

  .publish-readiness-card--ready {
    border-color: color-mix(in srgb, var(--smrt-color-primary) 35%, transparent);
  }

  .publish-readiness-card--advisory {
    border-color: color-mix(in srgb, var(--smrt-color-tertiary, #d97706) 45%, transparent);
  }

  .publish-readiness-card--blocked {
    border-color: color-mix(in srgb, var(--smrt-color-error) 45%, transparent);
  }

  .publish-readiness-card__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .publish-readiness-card__header strong {
    color: var(--smrt-color-on-surface);
  }

  .publish-readiness-card__profile {
    font-size: 0.8rem;
    color: var(--smrt-color-on-surface-variant);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .publish-readiness-card p {
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
  }

  .publish-readiness-card__list {
    margin: 0;
    padding-left: 1.25rem;
    color: var(--smrt-color-on-surface-variant);
  }
</style>
