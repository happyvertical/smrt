<script lang="ts">
import type { ResolvedObjectFieldPolicy } from '../../../types.js';
import ObjectForm from '../../components/ObjectForm.svelte';
import { FieldInputRegistry } from '../../input-registry.js';
import type { ObjectFormFieldDefinition } from '../../types.js';
import RegistryInput from './RegistryInput.svelte';

interface Props {
  fields: Record<string, ObjectFormFieldDefinition>;
  policy: ResolvedObjectFieldPolicy;
}

let { fields, policy }: Props = $props();
const registry = new FieldInputRegistry();
registry.registerField('@test:Product', 'name', RegistryInput);
let record = $state<Record<string, unknown>>({});
</script>

<ObjectForm
  objectRef={policy.objectRef}
  {fields}
  {policy}
  bind:value={record}
  inputRegistry={registry}
/>
