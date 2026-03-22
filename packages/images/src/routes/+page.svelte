<script lang="ts">
import { PlaygroundHost } from '@happyvertical/smrt-playground/svelte';
import imagesPlayground from '../playground.js';

const modules = [imagesPlayground];
</script>

<PlaygroundHost
  title="Images Playground"
  subtitle="Reference package previews for @happyvertical/smrt-images, using package-owned mock clients and the shared host shell."
  {modules}
/>
