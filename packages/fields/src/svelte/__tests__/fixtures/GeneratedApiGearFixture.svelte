<script lang="ts">
import FieldPolicyGearButton from '../../components/FieldPolicyGearButton.svelte';
import FieldPolicyGearProvider from '../../components/FieldPolicyGearProvider.svelte';
import type { FieldPolicyEditorAdapter } from '../../field-policy-editor.js';
import type { ObjectFormFieldDefinition } from '../../types.js';

interface Props {
  objectRef: string;
  fields: Record<string, ObjectFormFieldDefinition>;
  adapter: FieldPolicyEditorAdapter;
}

let { objectRef, fields, adapter }: Props = $props();
</script>

<FieldPolicyGearProvider {objectRef} {fields} {adapter}>
  <FieldPolicyGearButton />
</FieldPolicyGearProvider>
