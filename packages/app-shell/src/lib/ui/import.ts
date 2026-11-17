import type {
  Finding,
  ImportPlan,
  RunImportResult,
  UntranslatedFormula,
} from '@happyvertical/smrt-spreadsheets/import';
import type { RetainedImportPlan } from '../../engine/import-names.ts';
export interface ImportState {
  id: string;
  state: string;
  status: string;
  step: string;
  stopReason: string | null;
  draftId: string | null;
  note?: string;
  reason?: 'workbook' | 'plan' | 'engine' | 'budget' | 'paused' | 'app' | null;
  engine?: string;
  progress?: { stage: string; at: number }[];
  plan?: RetainedImportPlan;
  untranslatedFormulas?: UntranslatedFormula[];
  findings?: Finding[];
  proof?: RunImportResult;
}
export const importStages: Record<string, string> = {
  reading: 'Reading the workbook',
  planning: 'Planning the import',
  checking: 'Checking the plan',
  loading: 'Loading the draft',
  proving: 'Proving the loaded data',
  review: 'Your import is ready to review',
  failed: 'The import could not finish',
  cancelled: 'Import cancelled',
  discarded: 'Import discarded',
  published: 'Import published',
};
const findingWords: Record<Finding['code'], string> = {
  'sheet-missing': 'A source sheet is missing',
  'range-invalid': 'A source range is invalid',
  'header-outside-range': 'The header is outside the selected range',
  'column-outside-range': 'A source column is outside the selected range',
  'coerce-failed': 'A cell does not fit the proposed field type',
  'required-blank': 'A required value is blank',
  'digits-as-number': 'An identifier was proposed as a number',
  'lookup-key-not-unique': 'A lookup value appears more than once',
  'lookup-key-blank': 'A lookup value is blank',
  'reference-unresolved': 'A link could not find its matching record',
  'unmapped-column': 'A source column has not been mapped',
  'sum-unsafe': 'A total is too large to prove exactly',
  'row-count-mismatch': 'The loaded row count does not match the workbook',
  'sum-mismatch': 'A loaded total does not match the workbook',
  'calculated-invalid': 'A calculated value is invalid',
  'calculated-mismatch':
    'A calculation does not match the workbook’s cached result',
};
export function findingLabel(finding: Finding): string {
  return findingWords[finding.code] ?? 'The workbook needs a correction';
}
export function fieldLabel(
  plan: ImportPlan | undefined,
  table: string | undefined,
  field?: string,
): string {
  const t = plan?.tables.find((t) => t.key === table);
  return field
    ? (t?.fields.find((f) => f.key === field)?.label ?? 'Field')
    : (t?.label ?? 'Table');
}

/** Row preview: rows shown before "Show all", and the read ceiling. */
export const IMPORT_PREVIEW_ROWS = 3;
export const IMPORT_PREVIEW_MAX = 1000;

/** Plain-words type shown under a preview column name. */
export function previewType(
  field: {
    type: string;
    money?: { currency: string };
    reference?: { table: string };
  },
  plan?: ImportPlan,
): string {
  if (field.type === 'money')
    return field.money ? `money · ${field.money.currency}` : 'money';
  if (field.type === 'reference')
    return field.reference
      ? `link · ${fieldLabel(plan, field.reference.table)}`
      : 'link';
  return (
    { integer: 'whole number', boolean: 'yes or no' }[field.type] ?? field.type
  );
}

/** One cell of a loaded draft row, in the words the review uses. */
export function previewCell(
  value: unknown,
  field: { type: string; money?: { currency: string; scale: number } },
): string {
  if (value === null || value === undefined || value === '') return '';
  if (field.type === 'boolean') return value ? 'Yes' : 'No';
  if (field.type === 'money' && field.money && Number.isSafeInteger(value))
    return importTotal(value as number, field.money);
  if (field.type === 'date' && typeof value === 'string')
    return /^\d{4}-\d{2}-\d{2}T/.test(value) ? value.slice(0, 10) : value;
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** Render exact checked money totals in the workbook's currency. */
export function importTotal(
  total: number,
  money?: { currency: string; scale: number },
): string {
  if (!money) return total.toLocaleString();
  const amount = BigInt(total),
    negative = amount < 0n;
  const digits = (negative ? -amount : amount)
    .toString()
    .padStart(money.scale + 1, '0');
  const whole = money.scale ? digits.slice(0, -money.scale) : digits;
  return `${negative ? '-' : ''}${BigInt(whole).toLocaleString()}${money.scale ? `.${digits.slice(-money.scale)}` : ''} ${money.currency}`;
}
