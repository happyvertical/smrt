<script lang="ts">
import type { ControlInteractionRegistry } from '@happyvertical/smrt-ui/forms';
import Form from '../../components/forms/Form.svelte';
import TextInput from '../../components/forms/TextInput.svelte';
import Provider from '../../Provider.svelte';

let {
  providerRegistry,
  explicitRegistry,
  enableUi = true,
}: {
  providerRegistry: ControlInteractionRegistry;
  explicitRegistry: ControlInteractionRegistry;
  enableUi?: boolean;
} = $props();
</script>

<Provider
  webmcp={enableUi
    ? { ui: { controlRegistry: providerRegistry } }
    : { definitions: [] }}
>
  <Form formId="shared-form">
    <TextInput name="shared-name" label="Shared name" />
  </Form>
  <Form formId="explicit-form" interactionRegistry={explicitRegistry}>
    <TextInput name="explicit-name" label="Explicit name" />
  </Form>
</Provider>
