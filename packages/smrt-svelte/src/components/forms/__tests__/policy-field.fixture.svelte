<script lang="ts">
import { onDestroy, onMount } from 'svelte';
import { tryGetFormContext } from '../../../state/form-context.js';

let {
  sensitivity = 'public',
  writable = true,
}: {
  sensitivity?: 'public' | 'secret';
  writable?: boolean;
} = $props();
let value = $state('Ada');
const formContext = tryGetFormContext();

onMount(() => {
  formContext?.registerField({
    name: 'policy',
    type: 'text',
    label: 'Policy field',
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

onDestroy(() => formContext?.unregisterField('policy'));
</script>

<input name="policy" aria-label="Policy field" bind:value />
