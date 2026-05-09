<script lang="ts">
let {
  apiBaseUrl = '/api/v1',
  allowedTabs = [],
  enableDragToEditor = false,
  onSelect = undefined,
  onCancel = undefined,
} = $props<{
  apiBaseUrl?: string;
  allowedTabs?: string[];
  enableDragToEditor?: boolean;
  onSelect?: (value: unknown) => void;
  onCancel?: () => void;
}>();
</script>

<div
  data-testid="image-uploader-stub"
  data-api-base-url={apiBaseUrl}
  data-tab-count={allowedTabs.length}
  data-enable-drag-to-editor={enableDragToEditor ? 'true' : 'false'}
></div>
