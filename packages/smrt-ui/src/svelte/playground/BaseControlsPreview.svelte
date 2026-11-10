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

<div class="smrt-base-controls-preview__root" data-smrt-component="BaseControlsPreview">
  <div class="smrt-base-controls-preview__header" data-smrt-part="header">
    <div>
      <p class="smrt-base-controls-preview__eyebrow" data-smrt-part="label">Provider-free</p>
      <h4>Form controls</h4>
      <p class="smrt-base-controls-preview__supporting" data-smrt-part="description">
        Native semantics, shared focus states, and the active playground theme.
      </p>
    </div>
    <Badge variant="success">Ready</Badge>
  </div>

  <Form class="controls-form" onsubmit={handleSubmit}>
    <div class="smrt-base-controls-preview__control-grid" data-smrt-part="body">
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

      <div class="smrt-base-controls-preview__control-grid-wide" data-smrt-part="cell">
        <FormGroup label="Notes" hint="Resizable multiline input">
          <Textarea name="notes" rows={3} bind:value={notes} />
        </FormGroup>
      </div>

      <div class="smrt-base-controls-preview__control-grid-wide smrt-base-controls-preview__toggles" data-smrt-part="row">
        <Toggle label="Workspace enabled" bind:checked={enabled} />
        <Toggle label="Unavailable setting" disabled />
      </div>
    </div>

    <div class="smrt-base-controls-preview__actions" data-smrt-part="actions">
      <div class="smrt-base-controls-preview__actions-buttons" data-smrt-part="row">
        <Button type="submit">Save changes</Button>
        <Button variant="secondary">Duplicate</Button>
        <Button variant="ghost">Cancel</Button>
        <Button variant="danger">Delete</Button>
        <Button disabled>Disabled</Button>
      </div>
      <p class="smrt-base-controls-preview__save-status" data-smrt-part="status" aria-live="polite">
        {saveCount === 0
          ? 'Submit the form to test its event handling.'
          : `Saved ${saveCount} ${saveCount === 1 ? 'time' : 'times'}.`}
      </p>
    </div>
  </Form>

  <div class="smrt-base-controls-preview__status-row" data-smrt-part="row" aria-label="Badge variants">
    <span>Status</span>
    <Badge>Default</Badge>
    <Badge variant="primary">Primary</Badge>
    <Badge variant="success">Success</Badge>
    <Badge variant="warning">Warning</Badge>
    <Badge variant="error">Error</Badge>
  </div>
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-base-controls-preview__root {
    display: grid;
    gap: var(--smrt-spacing-6);
  }
  .smrt-base-controls-preview__header,
  .smrt-base-controls-preview__actions,
  .smrt-base-controls-preview__actions-buttons,
  .smrt-base-controls-preview__status-row,
  .smrt-base-controls-preview__toggles {
    display: flex;
    align-items: center;
  }
  .smrt-base-controls-preview__header,
  .smrt-base-controls-preview__actions {
    justify-content: space-between;
    gap: var(--smrt-spacing-4);
  }
  .smrt-base-controls-preview__header {
    padding-bottom: var(--smrt-spacing-4);
  }
  h4,
  p {
    margin: 0;
  }
  .smrt-base-controls-preview__eyebrow {
    margin-bottom: var(--smrt-spacing-1);
  }
  .smrt-base-controls-preview__supporting {
    margin-top: var(--smrt-spacing-1);
  }
  :global(.controls-form) {
    display: grid;
    gap: var(--smrt-spacing-4);
  }
  .smrt-base-controls-preview__control-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    column-gap: var(--smrt-spacing-6);
  }
  .smrt-base-controls-preview__control-grid-wide {
    grid-column: 1 / -1;
  }
  .smrt-base-controls-preview__toggles,
  .smrt-base-controls-preview__actions-buttons,
  .smrt-base-controls-preview__status-row {
    flex-wrap: wrap;
    gap: var(--smrt-spacing-3);
  }
  .smrt-base-controls-preview__toggles {
    min-height: 3rem;
  }
  .smrt-base-controls-preview__actions {
    align-items: flex-start;
    padding-top: var(--smrt-spacing-5);
  }
  .smrt-base-controls-preview__save-status {
    max-width: 18rem;
  }
  .smrt-base-controls-preview__status-row {
    padding: var(--smrt-spacing-4);
  }
  .smrt-base-controls-preview__status-row > span:first-child {
    margin-right: var(--smrt-spacing-1);
  }
  @media (max-width: 760px) {
    .smrt-base-controls-preview__control-grid {
      grid-template-columns: 1fr;
    }
    .smrt-base-controls-preview__control-grid-wide {
      grid-column: auto;
    }
    .smrt-base-controls-preview__header,
    .smrt-base-controls-preview__actions {
      align-items: flex-start;
      flex-direction: column;
    }
  }
}

@layer smrt.theme {
  .smrt-base-controls-preview__root {
    color: var(--smrt-color-on-surface);
  }
  .smrt-base-controls-preview__header {
    border-bottom: var(--smrt-hairline);
  }
  h4 {
    font: var(--smrt-typography-headline-small-font);
  }
  .smrt-base-controls-preview__eyebrow {
    color: var(--smrt-color-primary);
    font: var(--smrt-typography-label-small-font);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .smrt-base-controls-preview__supporting,
  .smrt-base-controls-preview__save-status,
  .smrt-base-controls-preview__status-row > span:first-child {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-base-controls-preview__supporting {
    font: var(--smrt-typography-body-medium-font);
  }
  .smrt-base-controls-preview__actions {
    border-top: var(--smrt-hairline);
  }
  .smrt-base-controls-preview__save-status {
    font: var(--smrt-typography-body-small-font);
    text-align: right;
  }
  .smrt-base-controls-preview__status-row {
    border-radius: var(--smrt-radius-medium);
    background: var(--smrt-color-surface-container-low);
  }
  .smrt-base-controls-preview__status-row > span:first-child {
    font: var(--smrt-typography-label-medium-font);
  }
  @media (max-width: 760px) {
    .smrt-base-controls-preview__save-status {
      text-align: left;
    }
  }
}

</style>
