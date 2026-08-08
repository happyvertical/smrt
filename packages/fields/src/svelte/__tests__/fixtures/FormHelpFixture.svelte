<script lang="ts">
import type { ResolvedObjectFieldPolicy } from '../../../types.js';
import FieldPolicyProvider from '../../components/FieldPolicyProvider.svelte';
import FormHelp from '../../components/FormHelp.svelte';

let {
  policy,
  objectDescription,
  mode = 'basic',
}: {
  policy: ResolvedObjectFieldPolicy;
  objectDescription?: string;
  mode?: 'basic' | 'advanced';
} = $props();
</script>

<FieldPolicyProvider {policy} {mode}>
  <FormHelp {objectDescription} />
</FieldPolicyProvider>
