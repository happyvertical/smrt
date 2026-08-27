<script lang="ts">
import { onMount } from 'svelte';
import {
  type FieldDefinition,
  getFormContext,
  tryGetFormContext,
} from '../../../state/form-context.js';

let {
  name,
  label,
  legacyCleanup = false,
  separateLegacyCleanupContext = false,
}: {
  name: string;
  label: string;
  legacyCleanup?: boolean;
  separateLegacyCleanupContext?: boolean;
} = $props();

let value = $state('');
const formContext = tryGetFormContext();
// Legacy helpers sometimes obtain the context again for teardown. The accessors
// must retain this component's ownership boundary across both calls.
// svelte-ignore state_referenced_locally
const cleanupContext = separateLegacyCleanupContext
  ? getFormContext()
  : formContext;

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
    ? () => cleanupContext?.unregisterField(field.name)
    : dispose;
});
</script>

<input {name} aria-label={label} bind:value />
