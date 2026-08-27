<script lang="ts">
import { onMount } from 'svelte';
import {
  type FieldDefinition,
  tryGetFormContext,
} from '../../../state/form-context.js';

let {
  name,
  label,
  legacyCleanup = false,
}: {
  name: string;
  label: string;
  legacyCleanup?: boolean;
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
  const dispose = formContext?.registerField(field);
  if (!formContext) return;
  return legacyCleanup
    ? () => formContext.unregisterField(field.name)
    : dispose;
});
</script>

<input {name} aria-label={label} bind:value />
