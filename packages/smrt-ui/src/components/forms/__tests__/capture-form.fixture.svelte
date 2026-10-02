<script lang="ts">
import CameraCapture from '../CameraCapture.svelte';
import SignaturePad from '../SignaturePad.svelte';

let {
  kind,
  ...props
}: {
  kind: 'camera' | 'signature';
  [key: string]: unknown;
} = $props();
</script>

<!-- A plain native form: no submit handler, no hidden inputs wired by the caller. -->
<form method="POST" enctype="multipart/form-data" action="/submit">
  <input type="hidden" name="note" value="hazard" />
  {#if kind === 'camera'}
    <CameraCapture {...props} />
  {:else}
    <SignaturePad {...props} />
  {/if}
  <button type="submit">Submit</button>
  <button type="reset">Reset form</button>
</form>
