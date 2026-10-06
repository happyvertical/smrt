import type { CatalogField } from '../catalog/types.ts';
import { isMoneyField } from './fakes.ts';

const currency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
});

/** Integer minor units (cents) as a display string, e.g. `1999` -> `$19.99`. */
export function formatMoney(minorUnits: number): string {
  return currency.format(minorUnits / 100);
}

/** Key of a related record in the label map a list view loads. */
export const labelKey = (modelId: string, id: unknown): string =>
  `${modelId}:${String(id)}`;

/**
 * Display text for one cell of a generated list view. A related record shows
 * its label from `labels` (see `relationLabels`), and only falls back to a
 * short id when the record is gone.
 */
export function formatValue(
  field: CatalogField,
  value: unknown,
  labels?: ReadonlyMap<string, string>,
): string {
  if (value === null || value === undefined || value === '') return '';
  if (isMoneyField(field) && typeof value === 'number') {
    return formatMoney(value);
  }
  if (field.enum?.includes(String(value))) return enumLabel(String(value));
  switch (field.type) {
    case 'boolean':
      return value ? 'Yes' : 'No';
    case 'datetime':
      return String(value).slice(0, 10);
    case 'foreignKey':
    case 'crossPackageRef':
      return (
        (field.related && labels?.get(labelKey(field.related, value))) ||
        String(value).slice(0, 8)
      );
    case 'json':
      return JSON.stringify(value);
    default:
      return String(value);
  }
}

/** Parse a money input given in major units (`"19.99"`) to integer cents. */
export function parseMoney(input: string): number {
  const value = Number.parseFloat(input);
  return Number.isFinite(value) ? Math.round(value * 100) : 0;
}

/** Humanize `productCount` / `product_count` as `Product count`. */
export function humanize(name: string): string {
  const spaced = name
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Text for an enum value: `qc_hold` is "Qc hold", and a short code such as
 * `dtc` stays an acronym ("DTC"). The stored value never changes.
 */
export function enumLabel(value: string): string {
  return /^[a-z]{1,3}$/.test(value) ? value.toUpperCase() : humanize(value);
}
