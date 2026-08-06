<script lang="ts">
/**
 * Test fixture: PolicyField with helpDensity='tooltip' to verify the help
 * text attaches to the label as a title attribute instead of rendering a
 * visible hint.
 */

import type { ResolvedObjectFieldPolicy } from '../../../types.js';
import FieldPolicyProvider from '../../components/FieldPolicyProvider.svelte';
import PolicyField from '../../components/PolicyField.svelte';

let {
  policy,
  helpDensity = 'tooltip',
}: {
  policy: ResolvedObjectFieldPolicy;
  helpDensity?: 'hint' | 'tooltip';
} = $props();
</script>

<FieldPolicyProvider {policy} mode="basic">
  <PolicyField name="name" {helpDensity}>
    <input id="name" name="name" type="text" />
  </PolicyField>
</FieldPolicyProvider>
