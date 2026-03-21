<script lang="ts">
import { PlaygroundHost } from '@happyvertical/smrt-playground/svelte';
import contentPlayground from '../playground.js';

const modules = [contentPlayground];
</script>

<PlaygroundHost
  title="Content Playground"
  subtitle="Reference package previews for @happyvertical/smrt-content, including live entries against the generated local API routes."
  {modules}
/>
