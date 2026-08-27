<script lang="ts">
import { onMount } from 'svelte';
import { tryGetFormContext } from '../../../state/form-context.js';

let {
  sensitivity = 'public',
  writable = true,
}: {
  sensitivity?: 'public' | 'secret';
  writable?: boolean;
} = $props();
let value = $state('Ada');
const policyLabel = 'Policy field';
const formContext = tryGetFormContext();

onMount(() => {
  return formContext?.registerField({
    name: 'policy',
    type: 'text',
    label: policyLabel,
    get sensitivity() {
      return sensitivity;
    },
    get writable() {
      return writable;
    },
    setValue: (next) => {
      value = String(next ?? '');
    },
    getValue: () => value,
  });
});
</script>

<input name="policy" aria-label={policyLabel} bind:value />
