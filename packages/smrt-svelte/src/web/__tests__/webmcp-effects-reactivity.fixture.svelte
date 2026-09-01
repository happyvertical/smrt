<script lang="ts">
import type { WebMcpToolEffect } from '@happyvertical/smrt-web';
import Provider from '../../Provider.svelte';
import ReactivityChild from './webmcp-effects-reactivity.child.fixture.svelte';

let { effects }: { effects: readonly WebMcpToolEffect[] } = $props();
</script>

<Provider webmcp={{ definitions: [], effects }}>
  <ReactivityChild />
</Provider>
