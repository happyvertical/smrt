<script lang="ts">
import type { ControlInteractionRegistry } from '@happyvertical/smrt-ui/forms';
import Form from '../../components/forms/Form.svelte';
import TextInput from '../../components/forms/TextInput.svelte';
import Provider from '../../Provider.svelte';

let {
  providerRegistry,
  explicitRegistry,
}: {
  providerRegistry: ControlInteractionRegistry;
  explicitRegistry: ControlInteractionRegistry;
} = $props();
</script>

<Provider webmcp={{ ui: { controlRegistry: providerRegistry } }}>
  <Form formId="shared-form">
    <TextInput name="shared-name" label="Shared name" />
  </Form>
  <Form formId="explicit-form" interactionRegistry={explicitRegistry}>
    <TextInput name="explicit-name" label="Explicit name" />
  </Form>
</Provider>
