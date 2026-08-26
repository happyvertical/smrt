<script lang="ts">
import type {
  ControlInteractionEvent,
  ControlInteractionRegistry,
} from '@happyvertical/smrt-ui/forms';
import Form from '../../components/forms/Form.svelte';
import TextInput from '../../components/forms/TextInput.svelte';
import Provider from '../../Provider.svelte';

let {
  providerRegistry,
  explicitRegistry,
  enableUi = true,
  onSharedInteraction,
  onSiblingInteraction,
}: {
  providerRegistry: ControlInteractionRegistry;
  explicitRegistry: ControlInteractionRegistry;
  enableUi?: boolean;
  onSharedInteraction?: (event: ControlInteractionEvent) => void;
  onSiblingInteraction?: (event: ControlInteractionEvent) => void;
} = $props();
</script>

<Provider
  webmcp={enableUi
    ? { ui: { controlRegistry: providerRegistry } }
    : { definitions: [] }}
>
  <Form formId="shared-form" oninteraction={onSharedInteraction}>
    <TextInput name="shared-name" label="Shared name" />
  </Form>
  <Form formId="sibling-form" oninteraction={onSiblingInteraction}>
    <TextInput name="sibling-name" label="Sibling name" />
  </Form>
  <Form formId="explicit-form" interactionRegistry={explicitRegistry}>
    <TextInput name="explicit-name" label="Explicit name" />
  </Form>
</Provider>
