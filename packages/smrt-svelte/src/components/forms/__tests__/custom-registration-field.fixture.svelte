<script lang="ts">
import { onMount } from 'svelte';
import {
  type FieldDefinition,
  tryGetFormContext,
} from '../../../state/form-context.js';

let {
  name,
  label,
}: {
  name: string;
  label: string;
} = $props();

let value = $state('');
const formContext = tryGetFormContext();

onMount(() => {
  const field: FieldDefinition = {
    name,
    type: 'text',
    label,
    setValue: (next) => {
      value = String(next ?? '');
    },
    getValue: () => value,
  };
  return formContext?.registerField(field);
});
</script>

<input {name} aria-label={label} bind:value />
