<script lang="ts">
import type { ResolvedObjectFieldPolicy } from '../../../types.js';
import FieldPolicyProvider from '../../components/FieldPolicyProvider.svelte';
import FormHelp from '../../components/FormHelp.svelte';

let {
  policy,
  objectDescription,
}: {
  policy: ResolvedObjectFieldPolicy;
  objectDescription?: string;
} = $props();
</script>

<FieldPolicyProvider {policy} mode="basic">
  <FormHelp {objectDescription} />
</FieldPolicyProvider>
