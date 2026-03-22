<script lang="ts">
import { PlaygroundHost } from '@happyvertical/smrt-playground/svelte';
import assetsPlayground from '../playground.js';

const modules = [assetsPlayground];
</script>

<PlaygroundHost
  title="Assets Playground"
  subtitle="Reference package previews for @happyvertical/smrt-assets, using package-owned mock data and the shared host shell."
  {modules}
/>
