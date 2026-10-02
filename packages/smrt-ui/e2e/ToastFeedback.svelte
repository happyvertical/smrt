<script lang="ts">
import ConfirmDialog from '../src/components/feedback/ConfirmDialog.svelte';
import Modal from '../src/components/feedback/Modal.svelte';
import ToastViewport from '../src/components/feedback/ToastViewport.svelte';
import { createToaster } from '../src/components/feedback/toast.js';

const toaster = createToaster({ successDuration: 0 });
let nativeDialog = $state<HTMLDialogElement>();
let first = $state(false);
let second = $state(false);
let confirm = $state(false);
let anchored = $state(false);
let region = $state<HTMLElement | null>(null);
let actions = $state(0);
let viewport = $state(true);
function notify() {
  toaster.success('Approval recorded', { action: { label: 'Undo approval', run: () => { actions++; } } });
}
</script>

<button type="button" onclick={() => { first = true; }}>Open first modal</button>
<button type="button" onclick={() => { anchored = !anchored; }}>Toggle anchor</button>
<button type="button" onclick={() => toaster.show({ message: 'Timed notification', duration: 1000 })}>Timed notification</button>
<button type="button" onclick={() => { viewport = false; }}>Unmount viewport</button>
<button type="button" onclick={notify}>Notify outside</button>
<output aria-label="Action count">{actions}</output>
<div bind:this={region} class="content-region">Content region</div>
{#if viewport}
  <div id="normal-host">
    <ToastViewport {toaster} position={anchored ? 'bottom-center' : 'bottom-end'} anchor={anchored ? region : null} inset="12px" />
  </div>
{/if}
<!-- Second is earlier in DOM order, but becomes the topmost dialog later. -->
<Modal bind:open={second} title="Second modal">
  <button type="button" onclick={notify}>Notify second</button>
  <button type="button" onclick={() => { confirm = true; }}>Open confirmation</button>
  <ConfirmDialog open={confirm} title="Top confirmation" message="Keep the modal open" oncancel={() => { confirm = false; }} />
</Modal>
<Modal bind:open={first} title="First modal">
  <button type="button" onclick={notify}>Notify first</button>
  <button type="button" onclick={() => { second = true; }}>Open second modal</button>
  <button type="button" onclick={() => nativeDialog?.showModal()}>Open native dialog</button>
</Modal>
<dialog bind:this={nativeDialog} aria-label="Native modal"><button type="button" onclick={() => nativeDialog?.close()}>Close native</button></dialog>
<dialog id="nonmodal" open>Nonmodal dialog</dialog>
<style>
  .content-region { position: absolute; top: 100px; left: 80px; width: 500px; height: 250px; }
</style>
