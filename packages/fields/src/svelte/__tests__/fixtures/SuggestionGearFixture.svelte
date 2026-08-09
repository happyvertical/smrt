<script lang="ts">
import FieldPolicyGearButton from '../../components/FieldPolicyGearButton.svelte';
import FieldPolicyGearProvider from '../../components/FieldPolicyGearProvider.svelte';
import type { FieldPolicyEditorAdapter } from '../../field-policy-editor.js';
import type { FieldPolicySuggestionAdapter } from '../../suggestions.js';

let {
  adapter,
  suggestionAdapter,
}: {
  adapter: FieldPolicyEditorAdapter;
  suggestionAdapter: FieldPolicySuggestionAdapter;
} = $props();
</script>

<FieldPolicyGearProvider
  objectRef="@test:Widget"
  fields={{ title: { type: 'text' } }}
  {adapter}
  {suggestionAdapter}
>
  <FieldPolicyGearButton />
</FieldPolicyGearProvider>
