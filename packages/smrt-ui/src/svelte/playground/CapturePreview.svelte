<script lang="ts">
import CameraCapture from '../../components/forms/CameraCapture.svelte';
import SignaturePad from '../../components/forms/SignaturePad.svelte';
import Switch from '../../components/forms/Switch.svelte';
import Button from '../../components/ui/Button.svelte';

let cameraOn = $state(false);
let stylusOnly = $state(false);
let posted = $state(
  'Submit the form to list what a native multipart post would send.',
);

function describeSubmission(
  event: SubmitEvent & { currentTarget: HTMLFormElement },
) {
  // The preview stays on the page; a real form would post natively.
  event.preventDefault();
  const entries = [...new FormData(event.currentTarget).entries()].map(
    ([key, value]) =>
      value instanceof File
        ? `${key}: ${value.name || '(empty file)'} ${value.size} B`
        : `${key}: ${value}`,
  );
  posted = entries.join(' · ');
}
</script>

<div class="workbench">
  <header>
    <p class="eyebrow">Native form capture</p>
    <h4>Camera and signature</h4>
    <p>Both controls post their file through a plain multipart form; no hidden input is wired by the page.</p>
  </header>
  <form method="POST" enctype="multipart/form-data" onsubmit={describeSubmission}>
    <section>
      <Switch name="camera-on" label="Camera on" bind:checked={cameraOn} interaction={false} />
      <CameraCapture name="photo" disabled={!cameraOn} />
    </section>
    <section>
      <Switch name="stylus-only" label="Stylus only" bind:checked={stylusOnly} interaction={false} />
      <SignaturePad name="signature" {stylusOnly} />
    </section>
    <Button type="submit">Submit</Button>
    <p class="posted" role="status">{posted}</p>
  </form>
</div>

<style>
  .workbench { display: grid; gap: var(--smrt-spacing-5); color: var(--smrt-color-on-surface); }
  header { display: grid; gap: var(--smrt-spacing-2); }
  h4, p { margin: 0; } h4 { font: var(--smrt-typography-headline-small-font); }
  header p:not(.eyebrow), .posted { color: var(--smrt-color-on-surface-variant); }
  .eyebrow { color: var(--smrt-color-primary); font: var(--smrt-typography-label-small-font); letter-spacing: .1em; text-transform: uppercase; }
  form { display: grid; gap: var(--smrt-spacing-6); }
  section { display: grid; gap: var(--smrt-spacing-3); min-width: 0; }
</style>
