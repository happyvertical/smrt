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
