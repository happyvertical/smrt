<script lang="ts">
/**
 * Test fixture: PolicyField rendered WITHOUT a FieldPolicyProvider.
 * Verifies graceful degradation — children render verbatim.
 */
import PolicyField from '../../components/PolicyField.svelte';
</script>

<PolicyField name="standalone">
  <input type="text" />
</PolicyField>
