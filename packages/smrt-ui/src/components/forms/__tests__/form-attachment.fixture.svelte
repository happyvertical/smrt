<script lang="ts">
import type { Action } from 'svelte/action';
import { fromAction } from 'svelte/attachments';
import type { ControlInteractionRegistry } from '../control-interaction.js';
import Form from '../Form.svelte';
import Input from '../Input.svelte';

interface Props {
  enhance: Action<HTMLFormElement, void>;
  registry: ControlInteractionRegistry;
  onsubmit?: (event: SubmitEvent) => void;
}

let { enhance, registry, onsubmit }: Props = $props();
</script>

<Form
  method="POST"
  action="/profile"
  preventDefault={false}
  formId="profile"
  interactionRegistry={registry}
  {onsubmit}
  {@attach fromAction(enhance)}
>
  <Input name="displayName" value="Dana" />
  <button type="submit">Save</button>
</Form>
