<script lang="ts">
/**
 * Test fixture: PolicyField with bind:value inputs to verify prefill.
 * - New record with default → input prefilled from resolved default
 * - Loaded record with existing value → input NOT clobbered by default
 */
import { untrack } from 'svelte';
import type { ResolvedObjectFieldPolicy } from '../../../types.js';
import FieldPolicyProvider from '../../components/FieldPolicyProvider.svelte';
import PolicyField from '../../components/PolicyField.svelte';

let {
  policy,
  isNewRecord = true,
  skuValue = '',
}: {
  policy: ResolvedObjectFieldPolicy;
  isNewRecord?: boolean;
  skuValue?: string;
} = $props();

// Seed the bound value once from the prop (untrack makes the one-shot capture
// explicit, mirroring ThemeProvider's SSR-seeding pattern — a loaded record's
// existing value must never be re-synced from the prop).
let sku = $state(untrack(() => skuValue));
</script>

<FieldPolicyProvider {policy} mode="basic">
  <PolicyField name="sku" {isNewRecord}>
    <input id="sku" name="sku" type="text" bind:value={sku} />
  </PolicyField>
  <div data-testid="sku-state">{sku}</div>
</FieldPolicyProvider>
