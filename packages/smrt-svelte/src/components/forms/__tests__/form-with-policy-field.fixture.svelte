<script lang="ts">
import type {
  ControlInteractionRegistry,
  ControlSensitivity,
} from '@happyvertical/smrt-ui/forms';
import Form from '../Form.svelte';
import PolicyField from './policy-field.fixture.svelte';

let {
  webmcp = false,
  interactionRegistry,
  sensitivity = 'public',
  writable = true,
}: {
  webmcp?: boolean;
  interactionRegistry?: ControlInteractionRegistry;
  sensitivity?: ControlSensitivity;
  writable?: boolean;
} = $props();
</script>

<Form {webmcp} {interactionRegistry} formId="policy-form">
  <PolicyField sensitivity={sensitivity === 'secret' ? 'secret' : 'public'} {writable} />
</Form>
