<script lang="ts">
let {
  apiBaseUrl = '/api/v1',
  allowedTabs = [],
  onSelect = undefined,
  onCancel = undefined,
} = $props<{
  apiBaseUrl?: string;
  allowedTabs?: string[];
  onSelect?: (value: unknown) => void;
  onCancel?: () => void;
}>();
</script>

<div
  data-testid="image-uploader-stub"
  data-api-base-url={apiBaseUrl}
  data-tab-count={allowedTabs.length}
></div>
