<script lang="ts">
/**
 * LeadCreateForm — host-driven manual Lead intake surface.
 *
 * The host supplies source and owner choices, handles persistence and dedupe,
 * and reports any duplicate or service error back through props.
 */
import { Form, FormGroup, Input, Select } from '@happyvertical/smrt-ui/forms';
import { Button } from '@happyvertical/smrt-ui/ui';
import type {
  LeadCreateDraft,
  LeadListItemView,
  LeadSourceOptionView,
  SalesRepOptionView,
} from '../types.js';

/** Props for {@link LeadCreateForm}. */
export interface Props {
  /** Representatives available for initial assignment. */
  reps?: SalesRepOptionView[];
  /** Open-string acquisition source choices supplied by the host. */
  sourceOptions?: LeadSourceOptionView[];
  /** Disable submission and editing during a host mutation. */
  busy?: boolean;
  /** Host-reported create failure. */
  error?: string;
  /** Possible duplicate returned by host dedupe. */
  duplicate?: LeadListItemView;
  /** Create a lead using the validated form draft. */
  onSubmit?: (draft: LeadCreateDraft) => void;
  /** Cancel intake. */
  onCancel?: () => void;
}

let {
  reps = [],
  sourceOptions = [],
  busy = false,
  error,
  duplicate,
  onSubmit,
  onCancel,
}: Props = $props();

let name = $state('');
let email = $state('');
let contactName = $state('');
let phone = $state('');
let organizationName = $state('');
let sourceKind = $state('');
let sourceId = $state('');
let ownerRepId = $state('');
let validationError = $state('');

const validEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

function submit() {
  if (busy) return;
  const normalizedName = name.trim();
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedName) {
    validationError = 'Name is required.';
    return;
  }
  if (!normalizedEmail && !phone.trim()) {
    validationError = 'Enter an email address or phone number.';
    return;
  }
  if (normalizedEmail && !validEmail(normalizedEmail)) {
    validationError = 'Enter a valid email address.';
    return;
  }
  validationError = '';
  onSubmit?.({
    name: normalizedName,
    email: normalizedEmail || undefined,
    contactName: contactName.trim() || undefined,
    phone: phone.trim() || undefined,
    organizationName: organizationName.trim() || undefined,
    sourceKind: sourceKind || sourceOptions[0]?.value || 'manual',
    sourceId: sourceId.trim() || undefined,
    ownerRepId: ownerRepId || undefined,
  });
}
</script>

<section class="sales-lead-create" aria-label="Create lead">
  <Form class="sales-lead-create__form" onsubmit={submit}>
    <FormGroup label="Lead name" required>
      <Input value={name} required disabled={busy} oninput={(event) => (name = event.currentTarget.value)} />
    </FormGroup>
    <FormGroup label="Email">
      <Input type="email" value={email} disabled={busy} oninput={(event) => (email = event.currentTarget.value)} />
    </FormGroup>
    <FormGroup label="Phone">
      <Input type="tel" value={phone} disabled={busy} oninput={(event) => (phone = event.currentTarget.value)} />
    </FormGroup>
    <FormGroup label="Contact name">
      <Input value={contactName} disabled={busy} oninput={(event) => (contactName = event.currentTarget.value)} />
    </FormGroup>
    <FormGroup label="Organization">
      <Input value={organizationName} disabled={busy} oninput={(event) => (organizationName = event.currentTarget.value)} />
    </FormGroup>
    {#if sourceOptions.length > 0}
      <FormGroup label="Source">
        <Select value={sourceKind || sourceOptions[0].value} disabled={busy} onchange={(event) => (sourceKind = event.currentTarget.value)}>
          {#each sourceOptions as option (option.value)}
            <option value={option.value}>{option.label}</option>
          {/each}
        </Select>
      </FormGroup>
    {/if}
    <FormGroup label="Source reference">
      <Input value={sourceId} disabled={busy} oninput={(event) => (sourceId = event.currentTarget.value)} />
    </FormGroup>
    {#if reps.length > 0}
      <FormGroup label="Owner">
        <Select value={ownerRepId} disabled={busy} onchange={(event) => (ownerRepId = event.currentTarget.value)}>
          <option value="">Unassigned</option>
          {#each reps as rep (rep.id)}
            <option value={rep.id}>{rep.name}</option>
          {/each}
        </Select>
      </FormGroup>
    {/if}
    {#if validationError || error}
      <p class="sales-lead-create__error" role="alert">{validationError || error}</p>
    {/if}
    {#if duplicate}
      <p class="sales-lead-create__duplicate" role="status">Possible duplicate: {duplicate.name}</p>
    {/if}
    <div class="sales-lead-create__actions">
      {#if onCancel}
        <Button type="button" variant="secondary" disabled={busy} onclick={() => onCancel?.()}>Cancel</Button>
      {/if}
      <Button type="submit" variant="primary" disabled={busy}>Create lead</Button>
    </div>
  </Form>
</section>

<style>
  :global(.sales-lead-create__form) { display: grid; gap: var(--smrt-spacing-3, 0.75rem); }
  .sales-lead-create__actions { display: flex; justify-content: flex-end; gap: var(--smrt-spacing-2, 0.5rem); }
  .sales-lead-create__error { color: var(--smrt-color-error, #dc2626); margin: 0; }
  .sales-lead-create__duplicate { color: var(--smrt-color-warning, #a16207); margin: 0; }
</style>
