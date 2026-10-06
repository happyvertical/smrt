<script lang="ts">
import type { CatalogField } from '../catalog/types.ts';
import { isMoneyField } from '../data/fakes.ts';
import { humanize, parseMoney } from '../data/format.ts';

interface FieldInputProps {
  field: CatalogField;
  /** The stored value (money is integer minor units). */
  value: unknown;
  onchange: (value: unknown) => void;
}

let { field, value, onchange }: FieldInputProps = $props();

const money = $derived(isMoneyField(field));
const label = $derived(humanize(field.name));
const id = $derived(`field-${field.name}`);
const text = $derived(
  value === null || value === undefined
    ? ''
    : typeof value === 'object'
      ? JSON.stringify(value)
      : String(value),
);

// Money is typed in major units but stored as integer cents. Keep what the
// person typed so re-rendering never rewrites the box mid-keystroke.
// svelte-ignore state_referenced_locally
let moneyText = $state(
  typeof value === 'number' ? (value / 100).toFixed(2) : '',
);

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
</script>

<div class="field">
  {#if field.type === 'boolean'}
    <label class="check">
      <input
        type="checkbox"
        checked={value === true}
        onchange={(event) => onchange(event.currentTarget.checked)}
      />
      {label}
    </label>
  {:else}
    <label for={id}>
      {label}
      {#if field.required}<span aria-hidden="true">*</span>{/if}
      {#if money}<small>(USD, stored as cents)</small>{/if}
    </label>
    {#if money}
      <input
        {id}
        type="number"
        onfocus={(event) => event.currentTarget.select()}
        step="0.01"
        min="0"
        required={field.required}
        value={moneyText}
        oninput={(event) => {
          // type=number would coerce a bound value to a number; keep the text.
          moneyText = event.currentTarget.value;
          onchange(moneyText.trim() === '' ? null : parseMoney(moneyText));
        }}
      />
    {:else if field.type === 'integer'}
      <input
        {id}
        type="number"
        onfocus={(event) => event.currentTarget.select()}
        step="1"
        required={field.required}
        value={text}
        oninput={(event) => {
          const parsed = numberFrom(event.currentTarget.value);
          onchange(parsed === null ? null : Math.trunc(parsed));
        }}
      />
    {:else if field.type === 'decimal'}
      <input
        {id}
        type="number"
        onfocus={(event) => event.currentTarget.select()}
        step="any"
        required={field.required}
        value={text}
        oninput={(event) => onchange(numberFrom(event.currentTarget.value))}
      />
    {:else if field.type === 'datetime'}
      <input
        {id}
        type="date"
        required={field.required}
        value={text.slice(0, 10)}
        oninput={(event) =>
          onchange(
            event.currentTarget.value
              ? new Date(event.currentTarget.value).toISOString()
              : '',
          )}
      />
    {:else if field.type === 'json'}
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
        required={field.required}
        value={text}
        oninput={(event) => onchange(event.currentTarget.value)}
      />
    {/if}
  {/if}
  {#if field.related}
    <small>References {field.related.split(':').pop()}</small>
  {/if}
</div>

<style>
  .field {
    display: grid;
    gap: var(--smrt-spacing-1);
  }

  label {
    font-weight: 500;
  }

  small {
    color: var(--smrt-color-on-surface-variant);
  }

  .check {
    display: flex;
    gap: var(--smrt-spacing-2);
    align-items: center;
  }

  input[type='text'],
  input[type='number'],
  input[type='date'],
  textarea {
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
    border: 1px solid var(--smrt-color-outline);
    border-radius: var(--smrt-radius-medium);
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    font: inherit;
  }
</style>
