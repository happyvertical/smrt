<script lang="ts">
let {
  apiBaseUrl = '/api/v1',
  assistantContext = null,
  contentId = '',
  currentEditorState = '',
  currentReferenceIds = [],
  formFields = {},
  onapplyfields = undefined,
  onclose = undefined,
} = $props<{
  apiBaseUrl?: string;
  assistantContext?: {
    data?: {
      contentId?: string;
      currentEditorState?: string;
      referenceIds?: string[];
      fields?: Record<string, string>;
    };
  } | null;
  contentId?: string;
  currentEditorState?: string;
  currentReferenceIds?: string[];
  formFields?: Record<string, string>;
  onapplyfields?: (fields: Record<string, string>) => void;
  onclose?: () => void;
}>();

const resolvedContentId = $derived(assistantContext?.data?.contentId ?? contentId);
const resolvedEditorState = $derived(
  assistantContext?.data?.currentEditorState ?? currentEditorState,
);
const resolvedReferenceIds = $derived(
  assistantContext?.data?.referenceIds ?? currentReferenceIds,
);
const resolvedFields = $derived(assistantContext?.data?.fields ?? formFields);
</script>

<div
  data-testid="content-agent-chat-stub"
  data-api-base-url={apiBaseUrl}
  data-content-id={resolvedContentId}
  data-body-length={resolvedEditorState.length}
  data-reference-count={resolvedReferenceIds.length}
  data-field-count={Object.keys(resolvedFields).length}
></div>
