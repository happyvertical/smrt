<script lang="ts">
/**
 * Test fixture: FieldPolicyProvider wrapping PolicyField-wrapped inputs.
 * Includes a mode toggle button to test switching between basic/advanced.
 *
 * The toggle lives in its own component so getContext runs during component
 * initialisation (the only valid time for getContext in Svelte 5) instead of
 * inside an event handler.
 */

import type { ResolvedObjectFieldPolicy } from '../../../types.js';
import FieldPolicyProvider from '../../components/FieldPolicyProvider.svelte';
import PolicyField from '../../components/PolicyField.svelte';
import ToggleModeButton from './ToggleModeButton.svelte';

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
    <input id="name" name="name" type="text" />
  </PolicyField>
  <PolicyField name="sku">
    <input id="sku" name="sku" type="text" />
  </PolicyField>
  <PolicyField name="wholesalePrice">
    <input id="wholesalePrice" name="wholesalePrice" type="number" />
  </PolicyField>
  <PolicyField name="internalNotes">
    <input id="internalNotes" name="internalNotes" type="text" />
  </PolicyField>
  <ToggleModeButton />
</FieldPolicyProvider>
