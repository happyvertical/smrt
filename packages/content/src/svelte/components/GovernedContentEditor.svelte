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
  /** Base URL for content and governance API requests. */
  apiBaseUrl?: string;
  /** Existing content to edit; omit to create new content. */
  content?: ContentData;
  /** ID of the content being edited; defaults to 'new'. */
  contentId?: string;
  /** Default relationship type for new facts added to the content. */
  defaultRelationship?: string;
  /** Key for the publication review profile to enforce. */
  reviewProfileKey?: string;
  /** Label shown for custom review workflow submissions. */
  customReviewLabel?: string;
  /** Instructions shown for custom review workflow submissions. */
  customReviewInstructions?: string;
  /** Policy key applied to custom review submissions. */
  customReviewPolicyKey?: string;
  /** Whether to require publication readiness before saving. */
  enforcePublishReadiness?: boolean;
  /** Whether to disable the save button. */
  saveDisabled?: boolean;
  /** Message displayed when save is disabled or unavailable. */
  saveNotice?: string | null;
  /** Whether the agent chat assistant panel is available. */
  agentChatEnabled?: boolean;
  /** Message displayed when agent chat is unavailable. */
  agentChatNotice?: string | null;
  /** Whether to hide the save and cancel action buttons. */
  hideActions?: boolean;
  /** Whether to hide the agent chat panel. */
  hideChat?: boolean;
  /** Whether to display the fact catalog panel. */
  showFactCatalog?: boolean;
  /** Whether to display the governance status panel. */
  showGovernancePanel?: boolean;
  /** Invoked when the assistant context changes during editing. */
  onAssistantContextChange?: ContentEditorAssistantContextChange;
  /** Invoked when the user saves the content. */
  onSave: (data: GovernedContentEditorSaveData) => void;
  /** Invoked when the user cancels editing. */
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

<div class="smrt-governed-content-editor__root" data-smrt-component="GovernedContentEditor">
  {#if publishReadinessState}
    <div class={`smrt-governed-content-editor__card smrt-governed-content-editor__card--${publishReadinessState.level}`} data-smrt-part="item">
      <div class="smrt-governed-content-editor__header" data-smrt-part="header">
        <strong>{publishReadinessState.title}</strong>
        <span class="smrt-governed-content-editor__profile" data-smrt-part="meta">
          {activeReviewProfileKey}
        </span>
      </div>
      <p>{publishReadinessState.message}</p>
      {#if publishReadinessState.details.length > 0}
        <ul class="smrt-governed-content-editor__list" data-smrt-part="list">
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
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-governed-content-editor__root {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }
  .smrt-governed-content-editor__card {
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
  }
  .smrt-governed-content-editor__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .smrt-governed-content-editor__card p {
    margin: 0;
  }
  .smrt-governed-content-editor__list {
    margin: 0;
    padding-left: 1.25rem;
  }
}

@layer smrt.theme {
  .smrt-governed-content-editor__card {
    border-radius: 0.75rem;
    border: var(--smrt-hairline);
    background: var(--smrt-color-surface-container-low);
  }
  .smrt-governed-content-editor__card--ready {
    border-color: color-mix(in srgb, var(--smrt-color-primary) 35%, transparent);
  }
  .smrt-governed-content-editor__card--advisory {
    border-color: color-mix(in srgb, var(--smrt-color-tertiary) 45%, transparent);
  }
  .smrt-governed-content-editor__card--blocked {
    border-color: color-mix(in srgb, var(--smrt-color-error) 45%, transparent);
  }
  .smrt-governed-content-editor__header strong {
    color: var(--smrt-color-on-surface);
  }
  .smrt-governed-content-editor__profile {
    font-size: var(--smrt-typography-label-medium-size, 0.8rem);
    color: var(--smrt-color-on-surface-variant);
    text-transform: uppercase;
    letter-spacing: var(--smrt-typography-label-medium-tracking, 0.04em);
  }
  .smrt-governed-content-editor__card p {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-governed-content-editor__list {
    color: var(--smrt-color-on-surface-variant);
  }
}

</style>
