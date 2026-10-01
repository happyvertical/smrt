<script lang="ts">
/** Rich Form hosting smrt-ui primitives, native attributes, and `enhance`. */
import {
  Combobox,
  type ControlInteractionRegistry,
  FormGroup,
  Input,
  Select,
} from '@happyvertical/smrt-ui/forms';
import type { Attachment } from 'svelte/attachments';
import Form, { type FormEnhance } from '../Form.svelte';
import TextInput from '../TextInput.svelte';

let {
  enhance = undefined,
  attach = undefined,
  interactionRegistry = undefined,
  nameValue = $bindable(''),
}: {
  enhance?: FormEnhance;
  attach?: Attachment<HTMLFormElement>;
  interactionRegistry?: ControlInteractionRegistry;
  nameValue?: string;
} = $props();
let kind = $state('news');
let town = $state('lacombe');
let tagline = $state('');
</script>

{#if attach}
  <Form
    formId="setup-network"
    webmcp
    method="POST"
    action="?/create"
    enctype="multipart/form-data"
    novalidate
    aria-label="Set up your network"
    data-testid="network-form"
    {enhance}
    {interactionRegistry}
    {@attach attach}
  >
    {@render fields()}
  </Form>
{:else}
  <Form
    formId="setup-network"
    webmcp
    method="POST"
    action="?/create"
    enctype="multipart/form-data"
    novalidate
    aria-label="Set up your network"
    data-testid="network-form"
    {enhance}
    {interactionRegistry}
  >
    {@render fields()}
  </Form>
{/if}

{#snippet fields()}
  <FormGroup label="Network name" id="name">
    <Input name="name" bind:value={nameValue} />
  </FormGroup>
  <FormGroup label="Kind of network" id="kind">
    <Select name="kind" bind:value={kind}>
      <option value="news">News</option>
      <option value="aggregator">Roundup</option>
    </Select>
  </FormGroup>
  <Combobox
    name="town"
    label="Home town"
    options={[
      { value: 'lacombe', label: 'Lacombe' },
      { value: 'blackfalds', label: 'Blackfalds' },
    ]}
    bind:value={town}
  />
  <TextInput name="tagline" label="Tagline" bind:value={tagline} />
  <button type="submit">Create</button>
{/snippet}
