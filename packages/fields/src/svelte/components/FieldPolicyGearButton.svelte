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
  <Button type="button" variant="ghost" class={className} aria-haspopup="dialog" aria-label={gear.pendingSuggestionCount > 0 ? `${label}, ${gear.pendingSuggestionCount} pending suggestion${gear.pendingSuggestionCount === 1 ? '' : 's'}` : label} onclick={() => gear.show()}>
    <span aria-hidden="true">⚙</span>
    <span>{label}</span>
    {#if gear.pendingSuggestionCount > 0}
      <span class="smrt-field-policy-gear-button__badge" data-smrt-part="count" aria-hidden="true">{gear.pendingSuggestionCount}</span>
    {/if}
  </Button>
{/if}

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-field-policy-gear-button__badge {
    min-inline-size: 1.25rem;
    padding-inline: 0.25rem;
  }
}

@layer smrt.theme {
  .smrt-field-policy-gear-button__badge {
    border-radius: 999px;
    background: var(--smrt-color-secondary-container);
    text-align: center;
  }
}

</style>
