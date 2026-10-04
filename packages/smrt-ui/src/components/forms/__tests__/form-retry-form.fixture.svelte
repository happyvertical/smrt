<script lang="ts">
import { fromAction } from 'svelte/attachments';
import Form from '../Form.svelte';
import type { FormRetry } from '../form-retry/controller.js';
import type { FormRetrySubmitFunction } from '../form-retry/types.js';
import Input from '../Input.svelte';

interface Props {
  /** SvelteKit's `enhance` action (here: the structural fake). */
  enhance: (
    form: HTMLFormElement,
    submit?: FormRetrySubmitFunction,
  ) => { destroy(): void };
  retry: FormRetry;
}

let { enhance, retry }: Props = $props();
</script>

<!-- The pairing the guide documents: kit's enhance with the retry submit
     function, plus the retry attachment for the hidden key field. -->
<Form
  method="POST"
  action="?/create"
  preventDefault={false}
  {@attach fromAction(enhance, () => retry.enhance())}
  {@attach retry.attach}
>
  <Input name="title" aria-label="Title" />
  <button type="submit">Send</button>
</Form>
