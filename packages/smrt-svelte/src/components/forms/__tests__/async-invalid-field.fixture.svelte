<script lang="ts">
import { onMount } from 'svelte';
import {
  type FieldDefinition,
  tryGetFormContext,
} from '../../../state/form-context.js';

let {
  validate,
}: {
  validate: () => boolean | Promise<boolean>;
} = $props();

const formContext = tryGetFormContext();
const label = 'Async invalid field';

onMount(() => {
  const field: FieldDefinition = {
    name: 'async-invalid',
    type: 'text',
    label,
    getValue: () => 'proposal',
    setValue: () => {},
    validate,
  };
  return formContext?.registerField(field);
});
</script>

<input aria-label={label} value="proposal" />
