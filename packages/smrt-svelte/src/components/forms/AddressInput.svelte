<script lang="ts">
import { onDestroy, onMount } from 'svelte';
import { useAppState } from '../../hooks/useAppState.svelte.js';
import {
  type FieldDefinition,
  tryGetFormContext,
} from '../../state/form-context.js';
import type { AddressValue } from './types.js';

type AddressField = keyof AddressValue;

export interface Props {
  /** Field name prefix */
  name: string;
  /** Field label */
  label?: string;
  /** Description for voice extraction */
  description?: string;
  /** Current value (bindable) */
  value?: Partial<AddressValue>;
  /** Which fields to show */
  fields?: AddressField[];
  /** Disabled state */
  disabled?: boolean;
  /** Required field */
  required?: boolean;
  /** Error message to display */
  error?: string;
  /** Country options for dropdown */
  countries?: Array<{ value: string; label: string }>;
  /** Province/state options for dropdown */
  provinces?: Array<{ value: string; label: string }>;
  /** Called when value changes */
  onchange?: (value: Partial<AddressValue>) => void;
}

const defaultCountries = [
  { value: 'CA', label: 'Canada' },
  { value: 'US', label: 'United States' },
];

const defaultProvinces = [
  // Canada
  { value: 'AB', label: 'Alberta' },
  { value: 'BC', label: 'British Columbia' },
  { value: 'MB', label: 'Manitoba' },
  { value: 'NB', label: 'New Brunswick' },
  { value: 'NL', label: 'Newfoundland and Labrador' },
  { value: 'NS', label: 'Nova Scotia' },
  { value: 'NT', label: 'Northwest Territories' },
  { value: 'NU', label: 'Nunavut' },
  { value: 'ON', label: 'Ontario' },
  { value: 'PE', label: 'Prince Edward Island' },
  { value: 'QC', label: 'Quebec' },
  { value: 'SK', label: 'Saskatchewan' },
  { value: 'YT', label: 'Yukon' },
  // US States (common ones) - prefixed with US- to avoid collision with country codes
  { value: 'US-CA', label: 'California' },
  { value: 'US-NY', label: 'New York' },
  { value: 'US-TX', label: 'Texas' },
  { value: 'US-FL', label: 'Florida' },
  { value: 'US-WA', label: 'Washington' },
];

let {
  name,
  label,
  description,
  value = $bindable({}),
  fields = ['street', 'city', 'province', 'postalCode', 'country'],
  disabled = false,
  required = false,
  error,
  countries = defaultCountries,
  provinces = defaultProvinces,
  onchange,
}: Props = $props();

const app = useAppState();
const formContext = tryGetFormContext();

const isSmrt = $derived(app.state.mode === 'smrt');

// Initialize empty fields
let street = $state(value.street ?? '');
let city = $state(value.city ?? '');
let province = $state(value.province ?? '');
let postalCode = $state(value.postalCode ?? '');
let country = $state(value.country ?? 'CA');

// Keep in sync with external value changes
$effect(() => {
  if (value.street !== undefined && value.street !== street)
    street = value.street;
  if (value.city !== undefined && value.city !== city) city = value.city;
  if (value.province !== undefined && value.province !== province)
    province = value.province;
  if (value.postalCode !== undefined && value.postalCode !== postalCode)
    postalCode = value.postalCode;
  if (value.country !== undefined && value.country !== country)
    country = value.country;
});

function updateValue() {
  const newValue: Partial<AddressValue> = {};
  if (fields.includes('street')) newValue.street = street;
  if (fields.includes('city')) newValue.city = city;
  if (fields.includes('province')) newValue.province = province;
  if (fields.includes('postalCode')) newValue.postalCode = postalCode;
  if (fields.includes('country')) newValue.country = country;
  value = newValue;
  onchange?.(newValue);
}

// Parse spoken address text
function parseSpokenAddress(text: string): Partial<AddressValue> {
  const result: Partial<AddressValue> = {};
  const normalized = text.toLowerCase().trim();

  // Try to extract postal code (Canadian format: A1A 1A1 or US: 12345)
  const postalMatch = normalized.match(
    /([a-z]\d[a-z]\s?\d[a-z]\d)|(\d{5}(-\d{4})?)/i,
  );
  if (postalMatch) {
    result.postalCode = postalMatch[0].toUpperCase().replace(/\s+/g, ' ');
  }

  // Try to extract province/state
  for (const prov of provinces) {
    const regex = new RegExp(
      `\\b${prov.label.toLowerCase()}\\b|\\b${prov.value.toLowerCase()}\\b`,
      'i',
    );
    if (regex.test(normalized)) {
      result.province = prov.value;
      break;
    }
  }

  // Try to extract country
  if (/\bcanada\b/i.test(normalized)) {
    result.country = 'CA';
  } else if (/\bunited states\b|\busa\b|\bu\.?s\.?a?\.?\b/i.test(normalized)) {
    result.country = 'US';
  }

  // Common city extraction patterns
  const cityPatterns = [
    /(?:city\s+(?:of\s+)?|in\s+)([a-z\s]+?)(?:\s*,|\s+(?:ab|bc|mb|on|qc|sk|alberta|british columbia|ontario|quebec)|\s*$)/i,
  ];
  for (const pattern of cityPatterns) {
    const match = normalized.match(pattern);
    if (match) {
      result.city = match[1].trim().replace(/\b\w/g, (c) => c.toUpperCase());
      break;
    }
  }

  // Street address - try to extract number + street name pattern
  const streetMatch = normalized.match(
    /(\d+\s+[a-z\s]+(?:street|st|avenue|ave|road|rd|drive|dr|boulevard|blvd|way|lane|ln|crescent|cres|place|pl|court|ct))/i,
  );
  if (streetMatch) {
    result.street = streetMatch[1].replace(/\b\w/g, (c) => c.toUpperCase());
  }

  return result;
}

// Field labels
const fieldLabels: Record<AddressField, string> = {
  street: 'Street Address',
  city: 'City',
  province: 'Province/State',
  postalCode: 'Postal/ZIP Code',
  country: 'Country',
};

const primaryFieldId = $derived.by(() => {
  const firstField = fields[0] ?? 'street';

  switch (firstField) {
    case 'postalCode':
      return `${name}_postal`;
    default:
      return `${name}_${firstField}`;
  }
});

// Register with form context
onMount(() => {
  if (formContext) {
    const fieldDef: FieldDefinition = {
      name,
      type: 'address',
      label,
      description:
        description ||
        'A mailing address with street, city, province, postal code, and country',
      setValue: (v: unknown) => {
        if (v === null || v === undefined) {
          street = '';
          city = '';
          province = '';
          postalCode = '';
          country = 'CA';
          updateValue();
          return;
        }
        if (typeof v === 'object' && v !== null) {
          const addr = v as Partial<AddressValue>;
          if (addr.street !== undefined) street = addr.street;
          if (addr.city !== undefined) city = addr.city;
          if (addr.province !== undefined) province = addr.province;
          if (addr.postalCode !== undefined) postalCode = addr.postalCode;
          if (addr.country !== undefined) country = addr.country;
          updateValue();
          return;
        }
        // Try to parse spoken address
        const parsed = parseSpokenAddress(String(v));
        if (Object.keys(parsed).length > 0) {
          if (parsed.street) street = parsed.street;
          if (parsed.city) city = parsed.city;
          if (parsed.province) province = parsed.province;
          if (parsed.postalCode) postalCode = parsed.postalCode;
          if (parsed.country) country = parsed.country;
          updateValue();
        }
      },
      getValue: () => value,
    };
    formContext.registerField(fieldDef);
  }
});

onDestroy(() => {
  if (formContext) {
    formContext.unregisterField(name);
  }
});

function handleStreetInput(e: Event) {
  street = (e.target as HTMLInputElement).value;
  updateValue();
}

function handleCityInput(e: Event) {
  city = (e.target as HTMLInputElement).value;
  updateValue();
}

function handleProvinceChange(e: Event) {
  province = (e.target as HTMLSelectElement).value;
  updateValue();
}

function handlePostalInput(e: Event) {
  postalCode = (e.target as HTMLInputElement).value;
  updateValue();
}

function handleCountryChange(e: Event) {
  country = (e.target as HTMLSelectElement).value;
  updateValue();
}
</script>

  <div class="smrt-address">
  {#if label}
    <label class="smrt-label" for={primaryFieldId}>
      {label}
      {#if required}<span class="required">*</span>{/if}
    </label>
  {/if}

  <div class="address-fields" class:smrt-mode={isSmrt}>
    {#if fields.includes('street')}
      <div class="field-row full-width">
        <label for="{name}_street" class="field-label">{fieldLabels.street}</label>
        <input
          id="{name}_street"
          name="{name}[street]"
          type="text"
          placeholder="123 Main Street"
          value={street}
          {disabled}
          required={required && fields.includes('street')}
          class="smrt-input"
          class:invalid={!!error}
          oninput={handleStreetInput}
        />
      </div>
    {/if}

    <div class="field-row-group">
      {#if fields.includes('city')}
        <div class="field-row flex-2">
          <label for="{name}_city" class="field-label">{fieldLabels.city}</label>
          <input
            id="{name}_city"
            name="{name}[city]"
            type="text"
            placeholder="City"
            value={city}
            {disabled}
            required={required && fields.includes('city')}
            class="smrt-input"
            class:invalid={!!error}
            oninput={handleCityInput}
          />
        </div>
      {/if}

      {#if fields.includes('province')}
        <div class="field-row flex-1">
          <label for="{name}_province" class="field-label">{fieldLabels.province}</label>
          <select
            id="{name}_province"
            name="{name}[province]"
            value={province}
            {disabled}
            required={required && fields.includes('province')}
            class="smrt-input smrt-select"
            class:invalid={!!error}
            onchange={handleProvinceChange}
          >
            <option value="">Select...</option>
            {#each provinces as prov (prov.value)}
              <option value={prov.value}>{prov.label}</option>
            {/each}
          </select>
        </div>
      {/if}
    </div>

    <div class="field-row-group">
      {#if fields.includes('postalCode')}
        <div class="field-row flex-1">
          <label for="{name}_postal" class="field-label">{fieldLabels.postalCode}</label>
          <input
            id="{name}_postal"
            name="{name}[postalCode]"
            type="text"
            placeholder="A1A 1A1"
            value={postalCode}
            {disabled}
            required={required && fields.includes('postalCode')}
            class="smrt-input"
            class:invalid={!!error}
            oninput={handlePostalInput}
          />
        </div>
      {/if}

      {#if fields.includes('country')}
        <div class="field-row flex-1">
          <label for="{name}_country" class="field-label">{fieldLabels.country}</label>
          <select
            id="{name}_country"
            name="{name}[country]"
            value={country}
            {disabled}
            required={required && fields.includes('country')}
            class="smrt-input smrt-select"
            class:invalid={!!error}
            onchange={handleCountryChange}
          >
            {#each countries as c (c.value)}
              <option value={c.value}>{c.label}</option>
            {/each}
          </select>
        </div>
      {/if}
    </div>
  </div>

  {#if error}
    <div class="validation-error">{error}</div>
  {/if}
</div>

<style>
  .smrt-address {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .smrt-label {
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
    font-weight: var(--smrt-typography-body-medium-weight, 500);
    color: var(--smrt-color-on-surface, #374151);
  }

  .smrt-label .required {
    color: var(--smrt-color-error, #ba1a1a);
    margin-left: 2px;
  }

  .address-fields {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-3, 12px);
    padding: var(--smrt-spacing-4, 16px);
    background: var(--smrt-color-surface-container-low, #f9fafb);
    border: 1px solid var(--smrt-color-outline-variant, #e5e7eb);
    border-radius: var(--smrt-radius-medium, 8px);
  }

  .address-fields.smrt-mode {
    border-color: var(--smrt-color-tertiary, #6b5778);
    background: var(--smrt-color-tertiary-container, #f3e5f5);
  }

  .field-row {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1, 4px);
  }

  .field-row-group {
    display: flex;
    gap: 12px;
  }

  .full-width {
    width: 100%;
  }

  .flex-1 {
    flex: 1;
  }

  .flex-2 {
    flex: 2;
  }

  .field-label {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    font-weight: var(--smrt-typography-body-small-weight, 500);
    color: var(--smrt-color-on-surface-variant, #6b7280);
    text-transform: uppercase;
    letter-spacing: 0.025em;
  }

  .smrt-input {
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-3, 12px);
    font-size: var(--smrt-typography-body-large-size, 1rem);
    border: 1px solid var(--smrt-color-outline-variant, #d1d5db);
    border-radius: var(--smrt-radius-small, 6px);
    background: var(--smrt-color-surface, #fff);
    transition: all var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }

  .smrt-input:focus {
    outline: none;
    border-color: var(--smrt-color-primary, #005ac1);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--smrt-color-primary, #005ac1) 10%, transparent);
  }

  .smrt-input:disabled {
    background: var(--smrt-color-surface-container-high, #f3f4f6);
    cursor: not-allowed;
  }

  .smrt-input.invalid {
    border-color: var(--smrt-color-error, #ba1a1a);
  }

  .smrt-select {
    cursor: pointer;
  }

  .validation-error {
    font-size: 0.75rem;
    color: var(--smrt-color-error, #ba1a1a);
    margin-top: 4px;
  }

  @media (max-width: 600px) {
    .field-row-group {
      flex-direction: column;
    }
  }
</style>
