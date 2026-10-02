<script lang="ts">
import CameraCapture from '../CameraCapture.svelte';
import SignaturePad from '../SignaturePad.svelte';

let {
  kind,
  inFieldset = false,
  ...props
}: {
  kind: 'camera' | 'signature';
  /** Wrap the component in a `<fieldset>` the test can disable. */
  inFieldset?: boolean;
  [key: string]: unknown;
} = $props();
</script>

{#snippet capture()}
  {#if kind === 'camera'}
    <CameraCapture {...props} />
  {:else}
    <SignaturePad {...props} />
  {/if}
{/snippet}

<!-- A plain native form: no submit handler, no hidden inputs wired by the caller. -->
<form method="POST" enctype="multipart/form-data" action="/submit">
  <input type="hidden" name="note" value="hazard" />
  {#if inFieldset}
    <fieldset>
      <legend>Capture</legend>
      {@render capture()}
    </fieldset>
  {:else}
    {@render capture()}
  {/if}
  <button type="submit">Submit</button>
  <button type="reset">Reset form</button>
</form>
