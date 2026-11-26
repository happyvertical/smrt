/**
 * GET /api/shell/import/preview?table=<plan key>&limit=3 -> { records, labels }.
 * Owner-only current review draft; rows are a database-ordered workbook prefix
 * (NULL provenance last, then id). Labels are keyed by row id and engine field,
 * resolved only for returned links. Query input never names engine identifiers.
 */

import { getDraftSlot, hostFor } from '$lib/server/host';
import { guarded, HttpError, json, ownerOf } from '$lib/server/http';
import { shellImports } from '$lib/server/import-runtime';
import { principalFor } from '$lib/server/owner';
import { recordLabel } from '$lib/ui/fields';
import { IMPORT_PREVIEW_MAX, IMPORT_PREVIEW_ROWS } from '$lib/ui/import';
import type { RecordRow } from '$lib/ui/types';
import {
  WORKBOOK_LOOKUP,
  WORKBOOK_ROW,
} from '../../../../../engine/import-bookkeeping.ts';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = guarded(async (event) => {
  const owner = await ownerOf(event);
  const current = await (await shellImports()).current(owner);
  const slot = await getDraftSlot();
  if (
    current?.status !== 'review' ||
    !current.proof?.ok ||
    !slot ||
    slot.id !== current.draftId
  )
    throw new HttpError(409, 'There is no workbook import ready to review.');
  const key = event.url.searchParams.get('table');
  const table = current.plan?.tables.find((table) => table.key === key);
  const names = table && current.plan?.engineNames?.tables[table.key];
  if (!table || !names)
    throw new HttpError(404, 'That table is not part of this workbook import.');
  const limit = Number(
    event.url.searchParams.get('limit') ?? IMPORT_PREVIEW_ROWS,
  );
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > IMPORT_PREVIEW_MAX)
    throw new HttpError(
      400,
      `Choose between 1 and ${IMPORT_PREVIEW_MAX} preview rows.`,
    );
  const host = await hostFor('draft');
  const definition = host.def.models[names.model];
  if (!definition?.fields[WORKBOOK_ROW])
    throw new HttpError(
      409,
      'This workbook preview is no longer available. Start the import again to see them.',
    );
  const fields = table.fields
    .map((field) => names.fields[field.key])
    .filter(
      (name) =>
        name !== WORKBOOK_ROW &&
        name !== WORKBOOK_LOOKUP &&
        definition?.fields[name] &&
        !definition.fields[name].hidden,
    );
  const caller = principalFor(owner, host.def);
  const stored = await host.readStoredRows(
    caller,
    names.model,
    ['id', ...fields],
    WORKBOOK_ROW,
    undefined,
    { limit, nullsLast: true },
  );
  const records = stored.map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([field, value]) => [
        field,
        typeof value === 'bigint'
          ? // JSON has no bigint: a safe value stays a number so money formats.
            Number.isSafeInteger(Number(value))
            ? Number(value)
            : value.toString()
          : definition.fields[field]?.type === 'boolean' && value !== null
            ? Boolean(value)
            : value,
      ]),
    ),
  );
  const links = fields.filter(
    (field) =>
      definition.fields[field].type === 'reference' &&
      definition.fields[field].ref,
  );
  const ids = new Map<string, Set<string>>();
  for (const field of links) {
    const model = definition.fields[field].ref!;
    const needed = ids.get(model) ?? new Set<string>();
    for (const row of records)
      if (typeof row[field] === 'string' && row[field])
        needed.add(row[field] as string);
    ids.set(model, needed);
  }
  const found = new Map<string, Map<string, string>>();
  for (const [model, needed] of ids) {
    const labels = new Map<string, string>();
    const batch = [...needed];
    for (let start = 0; start < batch.length; start += 500)
      for (const row of await host.listByIds(
        caller,
        model,
        batch.slice(start, start + 500),
      ))
        labels.set(
          String(row.id),
          recordLabel(host.def.models[model], row as RecordRow),
        );
    found.set(model, labels);
  }
  const labels: Record<string, Record<string, string>> = {};
  for (const row of records) {
    const cells: Record<string, string> = {};
    for (const field of links) {
      const label = found
        .get(definition.fields[field].ref!)
        ?.get(String(row[field]));
      if (label) cells[field] = label;
    }
    labels[String(row.id)] = cells;
  }
  return json({ records, labels });
});
