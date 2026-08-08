<script lang="ts">
/**
 * Test fixture: PolicyField wrapping a control with NO id attribute — the
 * wrapper must assign one so the label's `for` never dangles.
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
    <input type="text" />
  </PolicyField>
</FieldPolicyProvider>
