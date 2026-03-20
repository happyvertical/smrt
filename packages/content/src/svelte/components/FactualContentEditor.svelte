<script lang="ts">
import type { ContentData, FactData } from '../../mock-smrt-client';
import ContentEditor from './ContentEditor.svelte';
import FactualContentWorkflow from './FactualContentWorkflow.svelte';

export type FactualContentEditorSaveData = ContentData & {
  factIds: string[];
  facts: FactData[];
  isFactual: true;
};

export interface Props {
  content?: ContentData;
  contentId?: string;
  defaultRelationship?: string;
  reviewProfileKey?: string;
  customReviewLabel?: string;
  customReviewInstructions?: string;
  customReviewPolicyKey?: string;
  onSave: (data: FactualContentEditorSaveData) => void;
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
  onSave,
  onCancel,
} = $props<Props>();

function getInitialSelectedFactIds(nextContent?: ContentData) {
  return Array.isArray(nextContent?.factIds)
    ? nextContent.factIds.filter((factId): factId is string => Boolean(factId))
    : [];
}

function getInitialSelectedFacts(nextContent?: ContentData) {
  return Array.isArray(nextContent?.facts) ? nextContent.facts : [];
}

let selectedFactIds = $state<string[]>(getInitialSelectedFactIds(content));
let selectedFacts = $state<FactData[]>(getInitialSelectedFacts(content));
let lastResetKey = $state<string | null>(content?.id ?? contentId ?? null);
const resolvedContentId = $derived(content?.id ?? contentId);

$effect(() => {
  const nextResetKey = content?.id ?? contentId ?? null;
  if (nextResetKey === lastResetKey) {
    return;
  }

  lastResetKey = nextResetKey;
  selectedFactIds = getInitialSelectedFactIds(content);
  selectedFacts = getInitialSelectedFacts(content);
});

const factualContent = $derived(
  content
    ? {
        ...content,
        factIds: selectedFactIds,
        facts: selectedFacts,
        isFactual: true,
      }
    : undefined,
);

function handleFactsChange(factIds: string[], facts: FactData[]) {
  selectedFactIds = factIds;
  selectedFacts = facts;
}

function handleSave(data: ContentData) {
  onSave({
    ...data,
    factIds: selectedFactIds,
    facts: selectedFacts,
    isFactual: true,
  });
}
</script>

<div class="factual-editor">
  <ContentEditor
    content={factualContent}
    contentId={resolvedContentId}
    onSave={handleSave}
    onCancel={onCancel}
  />

  <FactualContentWorkflow
    contentId={resolvedContentId}
    selectedFactIds={selectedFactIds}
    selectedFacts={selectedFacts}
    defaultRelationship={defaultRelationship}
    reviewProfileKey={reviewProfileKey}
    customReviewLabel={customReviewLabel}
    customReviewInstructions={customReviewInstructions}
    customReviewPolicyKey={customReviewPolicyKey}
    onFactsChange={handleFactsChange}
  />
</div>

<style>
  .factual-editor {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }
</style>
