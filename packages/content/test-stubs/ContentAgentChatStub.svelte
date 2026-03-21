<script lang="ts">
let {
  apiBaseUrl = '/api/v1',
  contentId = '',
  currentEditorState = '',
  currentReferenceIds = [],
  formFields = {},
  onapplyfields = undefined,
  onclose = undefined,
} = $props<{
  apiBaseUrl?: string;
  contentId?: string;
  currentEditorState?: string;
  currentReferenceIds?: string[];
  formFields?: Record<string, string>;
  onapplyfields?: (fields: Record<string, string>) => void;
  onclose?: () => void;
}>();
</script>

<div
  data-testid="content-agent-chat-stub"
  data-api-base-url={apiBaseUrl}
  data-content-id={contentId}
  data-body-length={currentEditorState.length}
  data-reference-count={currentReferenceIds.length}
  data-field-count={Object.keys(formFields).length}
></div>
