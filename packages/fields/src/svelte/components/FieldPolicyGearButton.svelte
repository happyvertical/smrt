<script lang="ts">
import { Button } from '@happyvertical/smrt-ui/ui';
import { getFieldPolicyGearContext } from '../gear-context.svelte.js';

let {
  label = 'Field settings',
  class: className = '',
}: { label?: string; class?: string } = $props();
const gear = getFieldPolicyGearContext();
</script>

{#if gear.canEdit}
  <Button type="button" variant="ghost" class={className} aria-haspopup="dialog" onclick={() => gear.show()}>
    <span aria-hidden="true">⚙</span>
    <span>{label}</span>
  </Button>
{/if}
