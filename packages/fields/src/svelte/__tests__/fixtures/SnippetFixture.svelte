<script lang="ts">
/**
 * Test fixture: PolicyField snippet escape hatch with full policy data.
 * Verifies the snippet receives resolved label, help, required, etc.
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
  <PolicyField name="name">
    {#snippet render({ label, help, required })}
      <div data-testid="field-label">{label}</div>
      <div data-testid="field-help">{help}</div>
      <div data-testid="field-required">{String(required)}</div>
    {/snippet}
  </PolicyField>
</FieldPolicyProvider>
