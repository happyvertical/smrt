<script lang="ts">
import type { ResolvedObjectFieldPolicy } from '../../../types.js';
import AdvancedFields from '../../components/AdvancedFields.svelte';
import FieldPolicyProvider from '../../components/FieldPolicyProvider.svelte';
import PolicyField from '../../components/PolicyField.svelte';

let {
  policy,
  mode = 'advanced',
}: {
  policy: ResolvedObjectFieldPolicy;
  mode?: 'basic' | 'advanced';
} = $props();
</script>

<FieldPolicyProvider {policy} {mode}>
  <PolicyField name="name">
    <input id="name" name="name" type="text" />
  </PolicyField>
  <AdvancedFields>
    <PolicyField name="secretKey">
      <input id="secretKey" name="secretKey" type="text" />
    </PolicyField>
    {#if policy.fields.another}
      <PolicyField name="another">
        <input id="another" name="another" type="text" />
      </PolicyField>
    {/if}
  </AdvancedFields>
</FieldPolicyProvider>
