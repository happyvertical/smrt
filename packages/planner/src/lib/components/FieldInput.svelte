<script lang="ts">
import {
  AddressInput,
  DateTimeInput,
  MoneyInput,
  NumberInput,
  PhoneInput,
  SelectInput,
  TextareaInput,
  TextInput,
} from '@happyvertical/smrt-svelte/forms';
import {
  CurrencySelect,
  FieldLabel,
  Switch,
} from '@happyvertical/smrt-ui/forms';
import type { CatalogField } from '../catalog/types.ts';
import { enumLabel, humanize } from '../data/format.ts';
import { fromAddressInput, toAddressInput } from '../fields/address.ts';
import { fractionToPercent, percentToFraction } from '../fields/percent.ts';
import { chooseRenderer } from '../fields/renderer.ts';
import RelationField from './RelationField.svelte';

interface FieldInputProps {
  field: CatalogField;
  /** The stored value (money is integer minor units). */
  value: unknown;
  onchange: (value: unknown) => void;
  /** Qualified name of the model that owns the field (for per-model hints). */
  modelId?: string;
  /** Policy label; defaults to the humanized field name. */
  label?: string;
  /** Policy help text, shown under the control. */
  help?: string;
  /** Keeps element ids unique when several inputs for one field share a page. */
  idPrefix?: string;
  /** Drop the required marker, e.g. for a field's default value control. */
  hideRequired?: boolean;
  /** Let a relation selector offer "New ..." (off for a default-value control). */
  creatable?: boolean;
  /** Why the value is not acceptable; shown beside the field until it changes. */
  error?: string;
}

let {
  field,
  value,
  onchange,
  modelId,
  label: labelOverride,
  help,
  idPrefix = 'field',
  hideRequired = false,
  creatable = true,
  error,
}: FieldInputProps = $props();

const renderer = $derived(chooseRenderer(field, modelId));
const label = $derived(labelOverride ?? humanize(field.name));
const id = $derived(`${idPrefix}-${field.name}`);
const required = $derived(field.required && !hideRequired);
const text = $derived(
  value === null || value === undefined
    ? ''
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value),
);
// An optional enum can be cleared again, as the native select it replaces could.
// An enum that already lists '' (Invoice.collectionMethod) supplies that choice.
const enumOptions = $derived([
  ...(required || (field.enum ?? []).includes('')
    ? []
    : [{ value: '', label: '(none)' }]),
  ...(field.enum ?? []).map((option) => ({
    value: option,
    label: option === '' ? '(none)' : enumLabel(option),
  })),
]);

function numberFrom(raw: string): number | null {
  if (raw.trim() === '') return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function jsonFrom(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** A stored ISO timestamp as the date the picker shows. */
const dateOf = (stored: string): string => stored.slice(0, 10);
</script>

<div class="field" data-invalid={error ? '' : undefined}>
  {#if renderer === 'boolean'}
    <Switch
      checked={value === true}
      onchange={(event) => onchange(event.currentTarget.checked)}
      {label}
    />
  {:else if renderer === 'relation'}
    <RelationField
      {field}
      {value}
      {onchange}
      {label}
      name={id}
      {required}
      {creatable}
    />
  {:else if renderer === 'enum'}
    <SelectInput
      name={id}
      {label}
      {required}
      options={enumOptions}
      value={text}
      onchange={(next) => onchange(next)}
    />
  {:else if renderer === 'textarea'}
    <TextareaInput
      name={id}
      {label}
      {required}
      rows={4}
      value={text}
      onchange={(next) => onchange(next)}
    />
  {:else if renderer === 'email'}
    <TextInput
      name={id}
      {label}
      {required}
      type="email"
      value={text}
      onchange={(next) => onchange(next)}
    />
  {:else if renderer === 'phone'}
    <PhoneInput
      name={id}
      {label}
      {required}
      value={text}
      onchange={(next) => onchange(next)}
    />
  {:else if renderer === 'money'}
    <MoneyInput
      name={id}
      {label}
      {required}
      currency="USD"
      min={0}
      value={typeof value === 'number' ? value : null}
      onchange={(cents) => onchange(cents)}
    />
  {:else if renderer === 'percent'}
    <!-- Typed as a percentage (5), stored as the fraction the model expects (0.05). -->
    <div class="percent">
      <NumberInput
        name={id}
        {label}
        {required}
        min={0}
        step={0.01}
        value={fractionToPercent(value)}
        onchange={(percent) => onchange(percentToFraction(percent))}
      />
      <span class="percent-sign" aria-hidden="true">%</span>
    </div>
  {:else if renderer === 'datetime'}
    <DateTimeInput
      name={id}
      {label}
      {required}
      includeTime={false}
      value={dateOf(text)}
      onchange={(date) =>
        onchange(date ? new Date(`${date}T00:00:00Z`).toISOString() : '')}
    />
  {:else if renderer === 'address'}
    <AddressInput
      name={id}
      {label}
      {required}
      value={toAddressInput(value)}
      onchange={(edited) => onchange(fromAddressInput(edited, value))}
    />
  {:else}
    <FieldLabel for={id} {label} {required} />
    {#if renderer === 'currency'}
      <!-- ISO 4217 codes; the stored value is the code itself. -->
      <CurrencySelect
        {id}
        {required}
        value={text}
        onchange={(event) => onchange(event.currentTarget.value)}
      />
    {:else if renderer === 'url'}
      <input
        {id}
        type="url"
        {required}
        value={text}
        oninput={(event) => onchange(event.currentTarget.value)}
      />
    {:else if renderer === 'integer'}
      <input
        {id}
        type="number"
        onfocus={(event) => event.currentTarget.select()}
        step="1"
        {required}
        value={text}
        oninput={(event) => {
          const parsed = numberFrom(event.currentTarget.value);
          onchange(parsed === null ? null : Math.trunc(parsed));
        }}
      />
    {:else if renderer === 'decimal'}
      <input
        {id}
        type="number"
        onfocus={(event) => event.currentTarget.select()}
        step="any"
        {required}
        value={text}
        oninput={(event) => onchange(numberFrom(event.currentTarget.value))}
      />
    {:else if renderer === 'json'}
      <textarea
        {id}
        rows="3"
        value={text}
        oninput={(event) => onchange(jsonFrom(event.currentTarget.value))}
      ></textarea>
    {:else}
      <input
        {id}
        type="text"
        {required}
        value={text}
        oninput={(event) => onchange(event.currentTarget.value)}
      />
    {/if}
  {/if}
  {#if error}
    <p class="field-error" id={`${id}-error`} role="alert">{error}</p>
  {/if}
  {#if help}
    <small>{help}</small>
  {/if}
</div>

<style>
  .field {
    display: grid;
    gap: var(--smrt-spacing-1);
  }

  .percent {
    display: flex;
    align-items: flex-end;
    gap: var(--smrt-spacing-2);
  }

  .percent :global(.smrt-number) {
    flex: 1;
  }

  .percent-sign {
    padding-bottom: var(--smrt-spacing-2);
    color: var(--smrt-color-on-surface-variant);
  }

  .field-error {
    margin: 0;
    color: var(--smrt-color-error);
  }

  .field[data-invalid] :global(input),
  .field[data-invalid] :global(select),
  .field[data-invalid] :global(textarea) {
    border-color: var(--smrt-color-error);
  }

  small {
    color: var(--smrt-color-on-surface-variant);
  }


  input[type='text'],
  input[type='number'],
  input[type='url'],
  textarea {
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
    border: 1px solid var(--smrt-color-outline);
    border-radius: var(--smrt-radius-medium);
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    font: inherit;
  }
</style>
