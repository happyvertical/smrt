import type { ColumnMapping, ImportExportField } from './types.js';

/** Normalize a header or field name so `Created At`, `created_at` and `createdAt` agree. */
export function normalizeHeader(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+/g, '')
    .toLowerCase();
}

/**
 * Suggest a target field for each source header. Matching is by normalized
 * field name, then label, then declared alias; a field is claimed by at most
 * one column (the first match), and non-importable fields are never targets.
 */
export function autoMapColumns(
  headers: readonly string[],
  fields: readonly ImportExportField[],
): (string | null)[] {
  const importable = fields.filter((f) => f.importable);
  const claimed = new Set<string>();
  return headers.map((header) => {
    const key = normalizeHeader(header);
    if (!key) return null;
    const match =
      importable.find(
        (f) => !claimed.has(f.name) && normalizeHeader(f.name) === key,
      ) ??
      importable.find(
        (f) => !claimed.has(f.name) && normalizeHeader(f.label) === key,
      ) ??
      importable.find(
        (f) =>
          !claimed.has(f.name) &&
          (f.aliases ?? []).some((alias) => normalizeHeader(alias) === key),
      );
    if (!match) return null;
    claimed.add(match.name);
    return match.name;
  });
}

/** Replace one column's target, clearing any other column that held the same field. */
export function setColumnTarget(
  mapping: ColumnMapping,
  index: number,
  target: string | null,
): (string | null)[] {
  return mapping.map((current, i) => {
    if (i === index) return target;
    return target !== null && current === target ? null : current;
  });
}
