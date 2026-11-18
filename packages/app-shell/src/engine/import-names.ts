import type { ImportPlan } from '@happyvertical/smrt-spreadsheets/import';
import {
  type AppDefinition,
  EMPTY_APP,
  isValidFieldName,
  isValidModelName,
  tableFor,
  validate,
} from './definition.ts';

export const WORKBOOK_ROW = 'workbookRow';
export const WORKBOOK_LOOKUP = 'workbookLookup';

/** Retained with the plan, before any engine command is applied. */
export interface ImportNames {
  tables: Record<string, { model: string; fields: Record<string, string> }>;
  reports: Record<string, string>;
}
export type RetainedImportPlan = ImportPlan & { engineNames?: ImportNames };

function words(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}
const capital = (word: string) => word[0].toUpperCase() + word.slice(1);

/** Base spelling only; allocation below handles reserved names and collisions. */
export function importModelName(key: string): string {
  const name = words(key).map(capital).join('') || 'Table';
  return (/^[0-9]/.test(name) ? `Table${name}` : name).slice(0, 40);
}
export function importFieldName(key: string): string {
  const [first = 'field', ...rest] = words(key);
  const name =
    first +
    rest
      .map((word) => capital(word.length === 1 ? `${word}value` : word))
      .join('');
  return (/^[0-9]/.test(name) ? `field${name}` : name).slice(0, 40);
}

function allocate(base: string, allowed: (name: string) => boolean): string {
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? '' : String(n);
    const name = base.slice(0, 40 - suffix.length) + suffix;
    if (allowed(name)) return name;
  }
}

/** Plan order breaks ties; suffixes 2, 3, ... also fit inside the 40-character cap. */
export function importNames(
  plan: ImportPlan,
  existing: AppDefinition,
): ImportNames {
  const occupied = new Set(
    Object.keys(existing.models).map((name) => tableFor(name).toLowerCase()),
  );
  const toolPrefixes = new Set(
    Object.keys(existing.models).map((name) => name.toLowerCase()),
  );
  const tables: ImportNames['tables'] = {};
  for (const table of plan.tables) {
    const model = allocate(importModelName(table.key), (name) => {
      const storage = tableFor(name).toLowerCase();
      if (
        !isValidModelName(name) ||
        /^(app|approval)$/i.test(name) ||
        occupied.has(storage) ||
        toolPrefixes.has(name.toLowerCase())
      )
        return false;
      if (validate({ ...EMPTY_APP, models: { [name]: { fields: {} } } }).length)
        return false;
      occupied.add(storage);
      toolPrefixes.add(name.toLowerCase());
      return true;
    });
    const used = new Set([WORKBOOK_ROW, WORKBOOK_LOOKUP]);
    const fields: Record<string, string> = {};
    for (const field of table.fields) {
      fields[field.key] = allocate(importFieldName(field.key), (name) => {
        if (!isValidFieldName(name) || used.has(name)) return false;
        used.add(name);
        return true;
      });
    }
    tables[table.key] = { model, fields };
  }
  const reports: Record<string, string> = {};
  const usedReports = new Set(Object.keys(existing.reports ?? {}));
  for (const report of plan.reports ?? []) {
    reports[report.key] = allocate(importFieldName(report.key), (name) => {
      if (!isValidFieldName(name) || usedReports.has(name)) return false;
      usedReports.add(name);
      return true;
    });
  }
  return { tables, reports };
}
