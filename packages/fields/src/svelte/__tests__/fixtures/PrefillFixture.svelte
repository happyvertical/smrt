<script lang="ts">
/**
 * Test fixture: PolicyField with snippet escape hatch showing prefill signal.
 * Demonstrates that the snippet receives the default value from resolved policy.
 */

import type { ResolvedObjectFieldPolicy } from '../../../types.js';
import FieldPolicyProvider from '../../components/FieldPolicyProvider.svelte';
import PolicyField from '../../components/PolicyField.svelte';

let {
  policy,
  mode = 'basic',
}: {
  policy: ResolvedObjectFieldPolicy;
  mode?: 'basic' | 'advanced';
} = $props();
</script>

<FieldPolicyProvider {policy} {mode}>
  <PolicyField name="sku">
    {#snippet render({ defaultValue })}
      <div>Default: {String(defaultValue)}</div>
    {/snippet}
  </PolicyField>
</FieldPolicyProvider>
