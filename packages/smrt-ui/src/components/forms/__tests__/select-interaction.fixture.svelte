<script lang="ts">
import type { ControlInteractionRegistry } from '../control-interaction.js';
import Form from '../Form.svelte';
import Select from '../Select.svelte';

let {
  registry,
  required = false,
}: {
  registry: ControlInteractionRegistry;
  required?: boolean;
} = $props();
let role = $state('user');
</script>

<Form formId="account" interactionRegistry={registry} aria-label="Account form">
  <Select name="role" aria-label="Role" {required} bind:value={role}>
    <option value="">Choose a role</option>
    <option value="user">User</option>
    <option value="admin" disabled>Administrator</option>
    <optgroup label="Unavailable roles" disabled>
      <option value="owner">Owner</option>
    </optgroup>
  </Select>
</Form>
