<script lang="ts">
import ThemeProvider from '../../../themes/ThemeProvider.svelte';
import CameraCapture from '../CameraCapture.svelte';
import SignaturePad from '../SignaturePad.svelte';

let {
  density = 'comfortable',
  target = '48px',
}: { density?: 'comfortable' | 'touch'; target?: string } = $props();
</script>
<!-- Capture actions are touch targets at every density: comfortable is the default here on purpose. -->
<ThemeProvider {density} overrides={{ '--smrt-touch-target-min': target }} persist={false} inlineVariables>
  <CameraCapture name="photo" fileInputFallback interaction={false} />
  <SignaturePad name="signature" interaction={false} />
</ThemeProvider>
