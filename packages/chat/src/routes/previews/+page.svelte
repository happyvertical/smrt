<script lang="ts">
import { PlaygroundHost } from '@happyvertical/smrt-playground/svelte';
import chatPlayground from '../../playground.js';

const modules = [chatPlayground];
</script>

<PlaygroundHost
  title="Chat Previews"
  subtitle="Component previews for @happyvertical/smrt-chat."
  {modules}
/>
