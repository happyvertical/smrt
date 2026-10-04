<script lang="ts">
import ConfirmDialog from '../src/components/feedback/ConfirmDialog.svelte';
import Modal from '../src/components/feedback/Modal.svelte';
import Drawer from '../src/components/feedback/Drawer.svelte';

let modal = $state(false);
let drawer = $state(false);
let confirm = $state(false);
let cancellations = $state(0);
let loading = $state(false);
function cancel() {
  cancellations++;
  confirm = false;
}
</script>

<button type="button" onclick={() => { modal = true; }}>Open modal</button>
<button type="button" onclick={() => { drawer = true; }}>Open drawer</button>
<output aria-label="Cancellation count">{cancellations}</output>
{#snippet actions()}
  <button type="button" onclick={() => { confirm = true; }}>Request confirmation</button>
  <button type="button" onclick={() => { loading = true; confirm = true; }}>Loading confirmation</button>
  <ConfirmDialog open={confirm} title="Remove record" message={richMessage} {loading} oncancel={cancel} onconfirm={() => { confirm = false; }} />
{/snippet}
{#snippet richMessage()}
  Remove <strong>Floor record</strong>?
  <ul><li>Its notes</li><li>Its attachments</li></ul>
{/snippet}
{#if modal}
<Modal bind:open={modal} title="Parent modal" children={actions} />
{/if}
{#if drawer}
<Drawer bind:open={drawer} title="Parent drawer" children={actions} />
{/if}
