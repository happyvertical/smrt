<script lang="ts">
import { createControlInteractionRegistry } from '@happyvertical/smrt-ui/forms';
import {
  type FieldDefinition,
  type SMRTFormContext,
  setFormContext,
} from '../../../state/form-context.js';
import TextInput from '../TextInput.svelte';

let {
  showField = true,
  onregister,
  onunregister,
}: {
  showField?: boolean;
  onregister?: (name: string) => void;
  onunregister?: (name: string) => void;
} = $props();

const fields = new Map<string, FieldDefinition>();
const legacyContext: SMRTFormContext = {
  mode: 'default',
  registerField(field) {
    fields.set(field.name, field);
    onregister?.(field.name);
  },
  unregisterField(name) {
    fields.delete(name);
    onunregister?.(name);
  },
  getFieldSchema: () => Array.from(fields.values()),
  isFormListening: false,
  isExtracting: false,
  toggleListening: () => {},
  interactionRegistry: createControlInteractionRegistry(),
  formId: 'legacy-context',
};

setFormContext(legacyContext);
</script>

{#if showField}
  <TextInput name="legacy-field" label="Legacy field" />
{/if}
