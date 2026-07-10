<script lang="ts">
import Form from '../../components/forms/Form.svelte';
import FormGroup from '../../components/forms/FormGroup.svelte';
import Input from '../../components/forms/Input.svelte';
import Select from '../../components/forms/Select.svelte';
import Textarea from '../../components/forms/Textarea.svelte';
import Toggle from '../../components/forms/Toggle.svelte';
import Badge from '../../components/ui/Badge.svelte';
import Button from '../../components/ui/Button.svelte';

let name = $state('Ada Lovelace');
let email = $state('ada@example.com');
let seats = $state(12);
let startDate = $state('2026-07-09');
let role = $state('admin');
let notes = $state(
  'These controls stay lightweight because they do not require a Provider.',
);
let enabled = $state(true);
let saveCount = $state(0);

function handleSubmit() {
  saveCount += 1;
}
</script>

<div class="workbench">
  <div class="workbench__header">
    <div>
      <p class="eyebrow">Provider-free</p>
      <h4>Form controls</h4>
      <p class="supporting">
        Native semantics, shared focus states, and the active playground theme.
      </p>
    </div>
    <Badge variant="success">Ready</Badge>
  </div>

  <Form class="controls-form" onsubmit={handleSubmit}>
    <div class="control-grid">
      <FormGroup label="Name" hint="Standard text input" required>
        <Input name="name" bind:value={name} required />
      </FormGroup>

      <FormGroup label="Email" hint="Native email validation">
        <Input name="email" type="email" bind:value={email} />
      </FormGroup>

      <FormGroup label="Seats" hint="Numeric input">
        <Input name="seats" type="number" min="1" bind:value={seats} />
      </FormGroup>

      <FormGroup label="Start date" hint="Native date picker">
        <Input name="startDate" type="date" bind:value={startDate} />
      </FormGroup>

      <FormGroup label="Role" hint="Native select with themed chrome">
        <Select name="role" bind:value={role}>
          <option value="admin">Admin</option>
          <option value="editor">Editor</option>
          <option value="viewer">Viewer</option>
        </Select>
      </FormGroup>

      <FormGroup
        label="Workspace key"
        error="That key is already in use"
      >
        <Input name="workspaceKey" value="western-lab" />
      </FormGroup>

      <div class="control-grid__wide">
        <FormGroup label="Notes" hint="Resizable multiline input">
          <Textarea name="notes" rows={3} bind:value={notes} />
        </FormGroup>
      </div>

      <div class="control-grid__wide toggles">
        <Toggle label="Workspace enabled" bind:checked={enabled} />
        <Toggle label="Unavailable setting" disabled />
      </div>
    </div>

    <div class="actions">
      <div class="actions__buttons">
        <Button type="submit">Save changes</Button>
        <Button variant="secondary">Duplicate</Button>
        <Button variant="ghost">Cancel</Button>
        <Button variant="danger">Delete</Button>
        <Button disabled>Disabled</Button>
      </div>
      <p class="save-status" aria-live="polite">
        {saveCount === 0
          ? 'Submit the form to test its event handling.'
          : `Saved ${saveCount} ${saveCount === 1 ? 'time' : 'times'}.`}
      </p>
    </div>
  </Form>

  <div class="status-row" aria-label="Badge variants">
    <span>Status</span>
    <Badge>Default</Badge>
    <Badge variant="primary">Primary</Badge>
    <Badge variant="success">Success</Badge>
    <Badge variant="warning">Warning</Badge>
    <Badge variant="error">Error</Badge>
  </div>
</div>

<style>
  .workbench {
    display: grid;
    gap: var(--smrt-spacing-6);
    color: var(--smrt-color-on-surface);
  }

  .workbench__header,
  .actions,
  .actions__buttons,
  .status-row,
  .toggles {
    display: flex;
    align-items: center;
  }

  .workbench__header,
  .actions {
    justify-content: space-between;
    gap: var(--smrt-spacing-4);
  }

  .workbench__header {
    padding-bottom: var(--smrt-spacing-4);
    border-bottom: 1px solid var(--smrt-color-outline-variant);
  }

  h4,
  p {
    margin: 0;
  }

  h4 {
    font: var(--smrt-typography-headline-small-font);
  }

  .eyebrow {
    margin-bottom: var(--smrt-spacing-1);
    color: var(--smrt-color-primary);
    font: var(--smrt-typography-label-small-font);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .supporting,
  .save-status,
  .status-row > span:first-child {
    color: var(--smrt-color-on-surface-variant);
  }

  .supporting {
    margin-top: var(--smrt-spacing-1);
    font: var(--smrt-typography-body-medium-font);
  }

  :global(.controls-form) {
    display: grid;
    gap: var(--smrt-spacing-4);
  }

  .control-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    column-gap: var(--smrt-spacing-6);
  }

  .control-grid__wide {
    grid-column: 1 / -1;
  }

  .toggles,
  .actions__buttons,
  .status-row {
    flex-wrap: wrap;
    gap: var(--smrt-spacing-3);
  }

  .toggles {
    min-height: 3rem;
  }

  .actions {
    align-items: flex-start;
    padding-top: var(--smrt-spacing-5);
    border-top: 1px solid var(--smrt-color-outline-variant);
  }

  .save-status {
    max-width: 18rem;
    font: var(--smrt-typography-body-small-font);
    text-align: right;
  }

  .status-row {
    padding: var(--smrt-spacing-4);
    border-radius: var(--smrt-radius-medium);
    background: var(--smrt-color-surface-container-low);
  }

  .status-row > span:first-child {
    margin-right: var(--smrt-spacing-1);
    font: var(--smrt-typography-label-medium-font);
  }

  @media (max-width: 760px) {
    .control-grid {
      grid-template-columns: 1fr;
    }

    .control-grid__wide {
      grid-column: auto;
    }

    .workbench__header,
    .actions {
      align-items: flex-start;
      flex-direction: column;
    }

    .save-status {
      text-align: left;
    }
  }
</style>
