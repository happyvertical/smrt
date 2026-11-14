import {
  archiveAfter,
  archiveRow,
  assertJournalBounds,
  assertStoredJournalBounds,
  collectionFor,
  fieldsOf,
  quote,
  type Row,
  rawRows,
  replayId,
  undoRows,
} from './data-migrations.ts';
import type { AppDefinition, FieldDef } from './definition.ts';
import { snake, tableFor } from './definition.ts';
import { AppError } from './errors.ts';
import { titleField } from './reports.ts';

export interface ExtractModelCommand {
  type: 'extractModel';
  model: string;
  field: string;
  into: string;
  titleField?: string;
  /** Trim and match case-insensitively, off by default. */
  normalize?: boolean;
}
export interface ExtractPreview {
  rows: number;
  distinct: number;
  folded: number;
  create: number;
  matched: number;
}
const matching = (value: unknown, normalize: boolean) =>
  normalize
    ? String(value ?? '')
        .trim()
        .toLowerCase()
    : String(value ?? '');

export async function prepareExtract(
  def: AppDefinition,
  db: any,
  cmd: ExtractModelCommand,
) {
  if (cmd.normalize !== undefined && typeof cmd.normalize !== 'boolean')
    throw new AppError('normalize must be boolean');
  const target = Object.hasOwn(def.models, cmd.into)
    ? def.models[cmd.into]
    : undefined;
  const label = cmd.titleField ?? (target ? titleField(def, cmd.into) : 'name');
  if (!label) throw new AppError('extract target needs a title field');
  if (target) {
    const fields = fieldsOf(def, cmd.into);
    if (!['text', 'choice'].includes(fields[label]?.type))
      throw new AppError(
        'extract title field must be visible writable text or choice',
      );
  }
  const rows = await rawRows(def, db, cmd.model);
  const targets = target ? await rawRows(def, db, cmd.into) : [];
  const byTitle = new Map<string, Row[]>();
  for (const row of targets) {
    const key = matching(row[snake(label)], !!cmd.normalize);
    const matches = byTitle.get(key) ?? [];
    matches.push(row);
    byTitle.set(key, matches);
  }
  const groups = new Map<string, { value: string; rows: Row[]; id?: string }>();
  const distinct = new Set<string>();
  let count = 0;
  for (const row of rows) {
    const value = row[snake(cmd.field)];
    const key = matching(value, !!cmd.normalize);
    if (value == null || !key) continue;
    count++;
    distinct.add(String(value));
    const group = groups.get(key) ?? {
      value: cmd.normalize ? String(value).trim() : String(value),
      rows: [],
    };
    group.rows.push(row);
    groups.set(key, group);
  }
  const blanks = rows.filter(
    (row) =>
      row[snake(cmd.field)] != null &&
      !matching(row[snake(cmd.field)], !!cmd.normalize),
  );
  let matched = 0;
  for (const [key, group] of groups) {
    const matches = byTitle.get(key) ?? [];
    if (matches.length > 1)
      throw new AppError(`extract target has ambiguous values in '${label}'`);
    if (matches.length) {
      group.id = String(matches[0].id);
      matched++;
    } else {
      for (const [field, fd] of Object.entries(
        target ? fieldsOf(def, cmd.into) : {},
      ))
        if (field !== label && fd.required && !fd.calculated)
          throw new AppError(
            `extract target requires '${field}' to create new records`,
          );
      if (target && fieldsOf(def, cmd.into)[label]?.calculated)
        throw new AppError(
          'cannot create a record through a calculated title field',
        );
    }
    if (
      !matches.length &&
      target?.fields[label]?.type === 'choice' &&
      !target.fields[label].choices?.includes(group.value)
    )
      throw new AppError('extracted value is not a target choice');
  }
  assertJournalBounds([
    ...blanks,
    ...[...groups.values()].flatMap((group) => group.rows),
    ...[...groups.values()]
      .filter((group) => !group.id)
      .map((group) => ({ [label]: group.value })),
  ]);
  return {
    label,
    groups,
    blanks,
    preview: {
      rows: count,
      distinct: distinct.size,
      folded: distinct.size - groups.size,
      create: groups.size - matched,
      matched,
    } satisfies ExtractPreview,
  };
}
export async function applyExtract(
  def: AppDefinition,
  db: any,
  cmd: ExtractModelCommand,
  from: FieldDef,
  version: number,
  seed: string,
) {
  // The running definition already has the destination model and reference;
  // preparation reads the original physical source values within this tx.
  const { label, groups, blanks } = await prepareExtract(def, db, cmd);
  const collection = await collectionFor(def, db, cmd.into);
  for (const [key, group] of groups) {
    const id = group.id ?? replayId(seed, key);
    if (!group.id) {
      if (
        (
          await db.query(
            `SELECT 1 FROM ${quote(tableFor(cmd.into, def.models[cmd.into]))} WHERE id = ?`,
            [id],
          )
        ).rows.length
      )
        throw new AppError('extracted record id already exists');
      await archiveRow(db, version, cmd.into, id, null);
      await collection.create({ id, [label]: group.value } as never);
      const created = (
        await db.query(
          `SELECT * FROM ${quote(tableFor(cmd.into, def.models[cmd.into]))} WHERE id = ?`,
          [id],
        )
      ).rows[0];
      await archiveAfter(db, version, cmd.into, id, created);
    }
    for (const row of group.rows) {
      await archiveRow(db, version, cmd.model, String(row.id), row);
      await archiveAfter(db, version, cmd.model, String(row.id), {
        [snake(cmd.field)]: id,
      });
      await db.query(
        `UPDATE ${quote(tableFor(cmd.model, def.models[cmd.model]))} SET ${quote(snake(cmd.field))} = ? WHERE id = ?`,
        [id, row.id],
      );
    }
  }
  for (const row of blanks) {
    await archiveRow(db, version, cmd.model, String(row.id), row);
    await archiveAfter(db, version, cmd.model, String(row.id), {
      [snake(cmd.field)]: null,
    });
    await db.query(
      `UPDATE ${quote(tableFor(cmd.model, def.models[cmd.model]))} SET ${quote(snake(cmd.field))} = NULL WHERE id = ?`,
      [row.id],
    );
  }
  // Blank source values become null references; undo retains their exact text.
  // Keep original type data in the version for validation and undo registration.
  void from;
  await assertStoredJournalBounds(db, version);
}

/** No row created by a command may be removed while a surviving row references it. */
export async function assertCanUndoRows(
  def: AppDefinition,
  db: any,
  version: number,
  extraReferences: { model: string; field: string; ref: string }[] = [],
) {
  const entries = (
    await db.query(
      "SELECT tbl, record_id, value FROM _archive WHERE version = ? AND col = '$row'",
      [version],
    )
  ).rows as Row[];
  const before = new Map(
    entries.map((e) => [
      `${e.tbl}:${e.record_id}`,
      JSON.parse(String(e.value)) as Row | null,
    ]),
  );
  const references = Object.entries(def.models).flatMap(([model, md]) =>
    Object.entries(md.fields)
      .filter(([, f]) => f.type === 'reference')
      .map(([field, f]) => ({ model, field, ref: f.ref as string })),
  );
  const inserted = new Map<string, Set<unknown>>();
  for (const entry of entries) {
    if (JSON.parse(String(entry.value)) !== null) continue;
    const model = String(entry.tbl);
    const ids = inserted.get(model) ?? new Set<unknown>();
    ids.add(entry.record_id);
    inserted.set(model, ids);
  }
  for (const ref of [...references, ...extraReferences]) {
    const ids = inserted.get(ref.ref);
    if (!ids?.size) continue;
    for (const row of await rawRows(def, db, ref.model)) {
      const target = row[snake(ref.field)];
      if (!ids.has(target)) continue;
      const key = `${ref.model}:${row.id}`;
      if (before.has(key)) {
        const restored = before.get(key);
        if (restored === null || restored?.[snake(ref.field)] !== target)
          continue;
      }
      throw new AppError(
        `cannot undo: ${ref.model}.${ref.field} still references a created ${ref.ref} record`,
      );
    }
  }
}
export async function undoExtract(
  def: AppDefinition,
  db: any,
  cmd: ExtractModelCommand,
  version: number,
) {
  await assertCanUndoRows(def, db, version, [
    { model: cmd.model, field: cmd.field, ref: cmd.into },
  ]);
  const journal = (
    await db.query(
      "SELECT record_id, value FROM _archive WHERE version = ? AND tbl = ? AND col = '$after'",
      [version, cmd.model],
    )
  ).rows as Row[];
  const originals = new Map(
    journal.map((e) => [
      String(e.record_id),
      JSON.parse(String(e.value)) as Row,
    ]),
  );
  for (const row of await rawRows(def, db, cmd.model)) {
    const value = row[snake(cmd.field)];
    if (
      value != null &&
      value !== '' &&
      originals.get(String(row.id))?.[snake(cmd.field)] !== value
    )
      throw new AppError(
        `cannot undo extract: ${cmd.model}.${cmd.field} has a reference written since extraction; undo would leave a record id as text`,
      );
  }
  await undoRows(def, db, version);
}
