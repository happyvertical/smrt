<script lang="ts">
let {
  allowedTabs = [],
  onSelect = undefined,
  onCancel = undefined,
} = $props<{
  allowedTabs?: string[];
  onSelect?: (value: unknown) => void;
  onCancel?: () => void;
}>();
</script>

<div
  data-testid="image-uploader-stub"
  data-tab-count={allowedTabs.length}
></div>
