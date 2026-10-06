<script lang="ts">
import PermissionPicker, {
  type PermissionPickerItem,
} from '../PermissionPicker.svelte';

let {
  permissions,
  selected = [],
  disabled = false,
}: {
  permissions: PermissionPickerItem[];
  selected?: string[];
  disabled?: boolean;
} = $props();
</script>

<form aria-label="Role grants">
  <PermissionPicker {permissions} {selected} {disabled} />
</form>
