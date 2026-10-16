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
  field: CatalogField & { showTime?: boolean },
  value: unknown,
  labels?: ReadonlyMap<string, string>,
): string {
  if (value === null || value === undefined || value === '') return '';
  if (isMoneyField(field) && typeof value === 'number') {
    return formatMoney(value);
  }
  if (field.enum?.includes(String(value))) return enumLabel(String(value));
  if (isFractionRate(field) && typeof value === 'number') {
    return formatPercent(value);
  }
  switch (field.type) {
    case 'boolean':
      return value ? 'Yes' : 'No';
    case 'datetime':
      // A list of things that happen at a time (classes) shows it too.
      return field.showTime
        ? String(value).slice(0, 16).replace('T', ' ')
        : String(value).slice(0, 10);
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

/** English plural of a model's label: "Agreement" -> "Agreements". */
export function pluralize(label: string): string {
  if (/[^aeiou]y$/i.test(label)) return `${label.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(label)) return `${label}es`;
  return `${label}s`;
}

/**
 * Singular of a menu label's last word: "Sales Orders" -> "Sales Order",
 * "Currencies" -> "Currency". A label that is not plural is left as it is.
 */
export function singularize(label: string): string {
  if (/(series|species)$/i.test(label)) return label;
  if (/[^aeiou]ies$/i.test(label)) return `${label.slice(0, -3)}y`;
  if (/(ss|x|z|ch|sh)es$/i.test(label)) return label.slice(0, -2);
  if (/[^s]s$/i.test(label)) return label.slice(0, -1);
  return label;
}

/** What New creates for a menu entry: its declared noun, else the label's singular. */
export function navNoun(label: string, noun?: string): string {
  return (noun?.trim() || singularize(label)).toLowerCase();
}

/**
 * What a New button or form heading names. A page with one way to create a
 * record uses the menu entry's noun ("part", "member"); with several forms
 * (Simple, Clothing) each keeps its own label.
 */
export function createNoun(
  formLabel: string,
  noun: string | undefined,
  onlyForm: boolean,
): string {
  return onlyForm && noun?.trim() ? noun.trim() : formLabel.toLowerCase();
}

/** "1 record", "8 records". */
export function recordCount(count: number): string {
  return `${count} ${count === 1 ? 'record' : 'records'}`;
}

/**
 * A field's label: its humanized name, except a relation, which names the
 * record it points at ("Product", not "Product id").
 */
export function fieldLabel(field: CatalogField): string {
  const isRelation =
    field.type === 'foreignKey' || field.type === 'crossPackageRef';
  const name =
    isRelation && /[a-z]Id$/.test(field.name)
      ? field.name.slice(0, -2)
      : field.name;
  return humanize(name);
}

/** A fraction as a percentage: `0.0825` -> `8.25%`. */
export function formatPercent(fraction: number): string {
  return `${Number((fraction * 100).toFixed(2))}%`;
}

/** Rates stored as fractions (0.05 is 5%); other `*Rate` fields are unknown. */
export const isFractionRate = (field: CatalogField): boolean =>
  field.type === 'decimal' && /^(tax|discount|vat)Rate$/.test(field.name);

/**
 * Text for an enum value: `qc_hold` is "Qc hold", and a short code such as
 * `dtc` stays an acronym ("DTC"). The stored value never changes.
 */
export function enumLabel(value: string): string {
  return /^[a-z]{1,3}$/.test(value) ? value.toUpperCase() : humanize(value);
}
