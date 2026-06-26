<script lang="ts">
import { untrack } from 'svelte';
import type {
  ContentEditorAssistantContextChange,
  ContentEditorAssistantRegistration,
} from '../../content-editor-assistant';
import type {
  ContentData,
  ContentGovernanceStateData,
  FactAuditStateData,
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
  apiBaseUrl?: string;
  content?: ContentData;
  contentId?: string;
  defaultRelationship?: string;
  reviewProfileKey?: string;
  customReviewLabel?: string;
  customReviewInstructions?: string;
  customReviewPolicyKey?: string;
  enforcePublishReadiness?: boolean;
  saveDisabled?: boolean;
  saveNotice?: string | null;
  agentChatEnabled?: boolean;
  agentChatNotice?: string | null;
  hideActions?: boolean;
  hideChat?: boolean;
  showFactCatalog?: boolean;
  showGovernancePanel?: boolean;
  onAssistantContextChange?: ContentEditorAssistantContextChange;
  onSave: (data: GovernedContentEditorSaveData) => void;
  onCancel: () => void;
}

let {
  apiBaseUrl = '/api/v1',
  content = undefined,
  contentId = 'new',
  defaultRelationship = 'supports',
  reviewProfileKey = 'publication',
  customReviewLabel = 'Custom Review',
  customReviewInstructions = '',
  customReviewPolicyKey = 'custom',
  enforcePublishReadiness = false,
  saveDisabled = false,
  saveNotice = null,
  agentChatEnabled = true,
  agentChatNotice = null,
  hideActions = false,
  hideChat = false,
  showFactCatalog = false,
  showGovernancePanel = true,
  onAssistantContextChange = undefined,
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
let factAudit = $state<FactAuditStateData | null>(null);
let editorAssistantRegistration =
  $state<ContentEditorAssistantRegistration | null>(null);
const resolvedContentId = $derived(content?.id ?? contentId);
interface ContentEditorInstance {
  triggerSave?: () => void;
}
let innerEditor = $state<ContentEditorInstance | null>(null);

export function triggerSave() {
  if (publishSaveDisabled) return;
  if (innerEditor && typeof innerEditor.triggerSave === 'function') {
    innerEditor.triggerSave();
  }
}

interface GovernancePanelInstance {
  triggerReview?: (actionKind: string) => void;
}
let governancePanel = $state<GovernancePanelInstance | null>(null);

export function triggerReview(actionKind: string) {
  if (governancePanel && typeof governancePanel.triggerReview === 'function') {
    governancePanel.triggerReview(actionKind);
  }
}

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
  Boolean(saveDisabled || publishReadinessState?.disableSave),
);
const resolvedSaveNotice = $derived(publishSaveNotice || saveNotice || null);
const governedAssistantRegistration = $derived.by(() => {
  if (!editorAssistantRegistration) {
    return null;
  }

  const publishReadiness = publishReadinessState
    ? {
        level: publishReadinessState.level,
        title: publishReadinessState.title,
        message: publishReadinessState.message,
        disableSave: publishReadinessState.disableSave,
        details: [...publishReadinessState.details],
      }
    : null;

  return {
    context: {
      ...editorAssistantRegistration.context,
      data: {
        ...editorAssistantRegistration.context.data,
        editorKind: 'governed' as const,
        facts: {
          factIds: [...selectedFactIds],
          factCount: selectedFacts.length || selectedFactIds.length,
        },
        governance: {
          reviewProfileKey: activeReviewProfileKey,
          enforcePublishReadiness: activeEnforcePublishReadiness,
          publishReadiness,
        },
      },
    },
    actions: {
      ...editorAssistantRegistration.actions,
      triggerSave,
      triggerReview,
    },
  } satisfies ContentEditorAssistantRegistration;
});
let activeAssistantContextCallback:
  | ContentEditorAssistantContextChange
  | undefined;
let lastAssistantContextCallback:
  | ContentEditorAssistantContextChange
  | undefined;
let lastAssistantRegistration:
  | ContentEditorAssistantRegistration
  | null
  | undefined;

function publishAssistantRegistration(
  registration: ContentEditorAssistantRegistration | null,
) {
  const callback = activeAssistantContextCallback;
  if (!callback) {
    return;
  }

  if (
    callback === lastAssistantContextCallback &&
    registration === lastAssistantRegistration
  ) {
    return;
  }

  callback(registration);
  lastAssistantContextCallback = callback;
  lastAssistantRegistration = registration;
}

$effect(() => {
  const callback = onAssistantContextChange;
  activeAssistantContextCallback = callback;
  if (!callback) {
    lastAssistantContextCallback = undefined;
    lastAssistantRegistration = undefined;
    return;
  }

  publishAssistantRegistration(untrack(() => governedAssistantRegistration));

  return () => {
    if (activeAssistantContextCallback === callback) {
      activeAssistantContextCallback = undefined;
    }
    if (lastAssistantContextCallback === callback) {
      lastAssistantContextCallback = undefined;
      lastAssistantRegistration = undefined;
    }
    callback(null);
  };
});

$effect(() => {
  const registration = governedAssistantRegistration;
  untrack(() => publishAssistantRegistration(registration));
});

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

function handleFactAuditChange(state: FactAuditStateData | null) {
  factAudit = state;
}

function handleEditorAssistantContextChange(
  registration: ContentEditorAssistantRegistration | null,
) {
  editorAssistantRegistration = registration;
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
    bind:this={innerEditor}
    {apiBaseUrl}
    content={governedContent}
    contentId={resolvedContentId}
    {factAudit}
    saveDisabled={publishSaveDisabled}
    saveNotice={resolvedSaveNotice}
    {agentChatEnabled}
    {agentChatNotice}
    {hideActions}
    {hideChat}
    onAssistantContextChange={handleEditorAssistantContextChange}
    onChange={handleEditorChange}
    onFactAuditChange={handleFactAuditChange}
    onSave={handleSave}
    onCancel={onCancel}
  />

  {#if showGovernancePanel}
    <ContentGovernancePanel
      bind:this={governancePanel}
      {apiBaseUrl}
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
      {showFactCatalog}
      onFactsChange={handleFactsChange}
      onGovernanceStateChange={handleGovernanceStateChange}
      onFactAuditChange={handleFactAuditChange}
    />
  {/if}
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
    font-size: var(--smrt-typography-label-medium-size, 0.8rem);
    color: var(--smrt-color-on-surface-variant);
    text-transform: uppercase;
    letter-spacing: var(--smrt-typography-label-medium-tracking, 0.04em);
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
