<script lang="ts">
import type { ResolvedObjectFieldPolicy } from '../../../types.js';
import FieldPolicyProvider from '../../components/FieldPolicyProvider.svelte';
import ModeSwitch from '../../components/ModeSwitch.svelte';
import PolicyField from '../../components/PolicyField.svelte';

let { policy }: { policy: ResolvedObjectFieldPolicy } = $props();
</script>

<FieldPolicyProvider {policy} mode="basic">
  <ModeSwitch />
  <PolicyField name="name">
    <input id="name" name="name" type="text" />
  </PolicyField>
  <PolicyField name="secretKey">
    <input id="secretKey" name="secretKey" type="text" />
  </PolicyField>
</FieldPolicyProvider>
