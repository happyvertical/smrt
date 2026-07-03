<script lang="ts">
import type { Snippet } from 'svelte';

interface Props {
  side: 'left' | 'right';
  children: Snippet;
}

let { side, children }: Props = $props();
</script>

<div class="smrt-shell-corner" data-side={side}>
  {@render children()}
</div>

<style>
  .smrt-shell-corner {
    inline-size: var(--smrt-admin-shell-left-track);
    min-inline-size: 0;
  }

  .smrt-shell-corner[data-side='right'] {
    inline-size: var(--smrt-admin-shell-right-track);
  }
</style>
