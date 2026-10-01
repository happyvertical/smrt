<script lang="ts">
import {
  defineToolsDock,
  ToolsDock,
} from '../src/components/workspace/legacy.js';
import ToolBody from './ToolsDockTool.svelte';
import '@happyvertical/smrt-ui/styles/tokens.css';

const dock = defineToolsDock({
  tools: [{ id: 'notes', label: 'Notes', component: ToolBody }],
});
</script>

<main>
  <h1>Legacy tools dock fixture</h1>
</main>
<div class="dock-frame">
  <ToolsDock {dock} />
</div>

<style>
  :global(*) { box-sizing: border-box; }
  :global(body) { margin: 0; display: flex; font-family: sans-serif; }
  main { flex: 1; min-width: 0; }
  .dock-frame {
    position: relative;
    margin-inline-start: auto;
    display: flex;
    justify-content: flex-end;
    width: 3.25rem;
  }
</style>
