<script lang="ts">
import Form from '../Form.svelte';
import NumberInput from '../NumberInput.svelte';
import TextInput from '../TextInput.svelte';

let {
  onagechange,
  ontextchange,
}: {
  onagechange?: (value: number | null) => void;
  ontextchange?: (value: string) => void;
} = $props();
</script>

<Form showFormListen sttAdapter="browser-speech">
  <NumberInput name="age" label="Age" onchange={onagechange} />
  <TextInput name="fullname" label="Full name" onchange={ontextchange} />
</Form>
