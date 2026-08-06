<script lang="ts">
/**
 * Test fixture: an advanced-tier PolicyField with a resolved default that is
 * hidden at mount (basic mode) and revealed by the mode toggle. Verifies
 * prefill runs on first reveal, not only at mount.
 */
import type { ResolvedObjectFieldPolicy } from '../../../types.js';
import FieldPolicyProvider from '../../components/FieldPolicyProvider.svelte';
import PolicyField from '../../components/PolicyField.svelte';
import ToggleModeButton from './ToggleModeButton.svelte';

let {
  policy,
  isNewRecord = true,
}: {
  policy: ResolvedObjectFieldPolicy;
  isNewRecord?: boolean;
} = $props();

let wholesale = $state('');
</script>

<FieldPolicyProvider {policy} mode="basic">
  <PolicyField name="wholesalePrice" {isNewRecord}>
    <input id="wholesalePrice" name="wholesalePrice" type="number" bind:value={wholesale} />
  </PolicyField>
  <div data-testid="wholesale-state">{wholesale}</div>
  <ToggleModeButton />
</FieldPolicyProvider>
