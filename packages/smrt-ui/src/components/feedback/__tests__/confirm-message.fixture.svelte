<script lang="ts">
import ConfirmDialog from '../ConfirmDialog.svelte';
</script>

{#snippet message()}
  Remove <strong>Record name</strong>?
  <ul><li>Notes</li><li>Attachments</li></ul>
{/snippet}
<ConfirmDialog open title="Rich confirmation" {message} />
