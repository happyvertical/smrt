// Replayable data commands. Every handle here is the boot migration's executor;
// previews use a read transaction and the same preparation path as apply.
import { createHash } from 'node:crypto';
import {
  ObjectRegistry,
  withCallerOwnedDatabaseTransaction,
} from '@happyvertical/smrt-core';
import {
  type AppDefinition,
  builtInFields,
  classNameFor,
  coerceValue,
  snake,
  tableFor,
  USER_PKG,
  visible,
} from './definition.ts';
import { AppError } from './errors.ts';

export type Row = Record<string, unknown>;
export interface LoadRecordsCommand {
  type: 'loadRecords';
  model: string;
  rows: Row[];
  key?: string[];
  mode: 'insert' | 'upsert';
  references?: Record<string, { model: string; by: string }>;
}
export interface LoadPreview {
  insert: number;
  update: number;
  unchanged: number;
  rejected: number;
  problems: { row: number; field: string; reason: string }[];
}
export const LOAD_LIMITS = {
  rows: 10000,
  bytes: 8 * 1024 * 1024,
  problems: 100,
} as const;
/** All data commands share the load-sized undo journal budget. */
export const JOURNAL_LIMITS = {
  rows: LOAD_LIMITS.rows,
  bytes: LOAD_LIMITS.bytes,
} as const;
export function assertJournalBounds(rows: Row[]) {
  if (rows.length > JOURNAL_LIMITS.rows)
    throw new AppError(
      `undo journal accepts at most ${JOURNAL_LIMITS.rows} rows`,
    );
  if (Buffer.byteLength(JSON.stringify(rows)) > JOURNAL_LIMITS.bytes)
    throw new AppError(
      `undo journal accepts at most ${JOURNAL_LIMITS.bytes} bytes`,
    );
}
export async function assertStoredJournalBounds(db: any, version: number) {
  const count = (
    await db.query(
      "SELECT SUM(CASE WHEN col = '$row' THEN 1 ELSE 0 END) AS n, SUM(length(CAST(value AS BLOB))) AS bytes FROM _archive WHERE version = ? AND col IN ('$row', '$after', '$deleted')",
      [version],
    )
  ).rows[0];
  if (
    Number(count.n) > JOURNAL_LIMITS.rows ||
    Number(count.bytes) > JOURNAL_LIMITS.bytes
  )
    throw new AppError(
      `undo journal accepts at most ${JOURNAL_LIMITS.rows} rows and ${JOURNAL_LIMITS.bytes} bytes`,
    );
}
export const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;
export const fieldsOf = (def: AppDefinition, model: string) => {
  const md = def.models[model];
  if (!Object.hasOwn(def.models, model))
    throw new AppError(`no model ${model}`);
  return { ...builtInFields(model, md), ...visible(md.fields) };
};
export const collectionFor = (def: AppDefinition, db: any, model: string) => {
  fieldsOf(def, model);
  return ObjectRegistry.getCollection(
    `${USER_PKG}:${classNameFor(model, def.models[model])}`,
    { db },
  );
};

/** Raw rows preserve every storage column for exact undo, scoped to the app subtype. */
export async function rawRows(
  def: AppDefinition,
  db: any,
  model: string,
): Promise<Row[]> {
  const collection = await collectionFor(def, db, model);
  const type = collection.getStiChildMetaType();
  return (
    await db.query(
      `SELECT * FROM ${quote(tableFor(model, def.models[model]))}${type ? ' WHERE _meta_type = ?' : ''}`,
      type ? [type] : [],
    )
  ).rows;
}
export function stored(value: unknown): unknown {
  return value instanceof Date
    ? value.toISOString()
    : typeof value === 'boolean'
      ? Number(value)
      : value !== null && typeof value === 'object'
        ? JSON.stringify(value)
        : value;
}
const same = (a: unknown, b: unknown) => (a ?? null) === (b ?? null);
const keyFor = (values: unknown[]) => JSON.stringify(values);

/** Stable per-command ids: later draft commands can refer to loaded rows. */
export function replayId(seed: string, key: string): string {
  const hex = createHash('sha256').update(`${seed}:${key}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
/** Bound the whole call before it is cloned or sent to the worker. */
export function assertLoadBounds(cmd: LoadRecordsCommand) {
  if (!Array.isArray(cmd.rows) || cmd.rows.length > LOAD_LIMITS.rows)
    throw new AppError(`loadRecords accepts at most ${LOAD_LIMITS.rows} rows`);
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(cmd));
  } catch {
    throw new AppError('loadRecords needs JSON command data');
  }
  if (bytes > LOAD_LIMITS.bytes)
    throw new AppError(
      `loadRecords accepts at most ${LOAD_LIMITS.bytes} bytes`,
    );
}

export async function prepareLoad(
  def: AppDefinition,
  db: any,
  cmd: LoadRecordsCommand,
) {
  assertLoadBounds(cmd);
  if (!['insert', 'upsert'].includes(cmd.mode))
    throw new AppError('loadRecords mode must be insert or upsert');
  const fields = fieldsOf(def, cmd.model);
  if (cmd.mode === 'upsert' && (!Array.isArray(cmd.key) || !cmd.key.length))
    throw new AppError('upsert needs key fields');
  for (const key of cmd.key ?? [])
    if (!Object.hasOwn(fields, key) || fields[key].calculated)
      throw new AppError(`invalid key field '${key}'`);
  const lookups = new Map<string, Row[]>();
  const referenceMaps = new Map<string, Map<string, string[]>>();
  for (const [field, lookup] of Object.entries(cmd.references ?? {})) {
    if (
      !lookup ||
      !Object.hasOwn(fields, field) ||
      fields[field]?.type !== 'reference' ||
      fields[field].ref !== lookup.model
    )
      throw new AppError(`invalid reference lookup '${field}'`);
    const targetFields = fieldsOf(def, lookup.model);
    if (
      !Object.hasOwn(targetFields, lookup.by) ||
      targetFields[lookup.by].calculated
    )
      throw new AppError(`invalid lookup field '${lookup.by}'`);
  }
  // One query per referenced model, including references supplied directly by id.
  for (const [field, fd] of Object.entries(fields)) {
    if (
      fd.type !== 'reference' ||
      !fd.ref ||
      !cmd.rows.some((r) => r && Object.hasOwn(r, field))
    )
      continue;
    if (!lookups.has(fd.ref))
      lookups.set(fd.ref, await rawRows(def, db, fd.ref));
    const by = cmd.references?.[field]?.by;
    const map = new Map<string, string[]>();
    for (const row of lookups.get(fd.ref) ?? []) {
      const value = by ? row[snake(by)] : row.id;
      const key = keyFor([value]);
      const ids = map.get(key) ?? [];
      ids.push(String(row.id));
      map.set(key, ids);
    }
    referenceMaps.set(field, map);
  }
  const existing =
    cmd.mode === 'upsert' ? await rawRows(def, db, cmd.model) : [];
  const keys = new Map<string, Row[]>();
  for (const row of existing) {
    const key = keyFor((cmd.key ?? []).map((k) => row[snake(k)]));
    const group = keys.get(key) ?? [];
    group.push(row);
    keys.set(key, group);
  }
  const seenKeys = new Set<string>();
  const preview: LoadPreview = {
    insert: 0,
    update: 0,
    unchanged: 0,
    rejected: 0,
    problems: [],
  };
  const writes: { index: number; id?: string; data: Row; before?: Row }[] = [];
  for (const [index, row] of cmd.rows.entries()) {
    let rejected = false;
    const problem = (field: string, reason: string) => {
      rejected = true;
      if (preview.problems.length < LOAD_LIMITS.problems)
        preview.problems.push({ row: index, field, reason });
    };
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      problem('', 'row must be an object');
      preview.rejected++;
      continue;
    }
    const data: Row = {};
    for (const [field, value] of Object.entries(row)) {
      if (!Object.hasOwn(fields, field)) {
        problem(field, 'unknown or hidden field');
        continue;
      }
      const fd = fields[field];
      const lookup = cmd.references?.[field];
      let input = value;
      if (lookup && value != null && value !== '') {
        const converted = coerceValue(
          fieldsOf(def, lookup.model)[lookup.by],
          value,
        );
        if (!converted.ok) {
          problem(field, converted.error);
          continue;
        }
        const ids =
          referenceMaps.get(field)?.get(keyFor([stored(converted.value)])) ??
          [];
        if (ids.length !== 1) {
          problem(
            field,
            ids.length
              ? 'ambiguous reference lookup'
              : 'unresolved reference lookup',
          );
          continue;
        }
        input = ids[0];
      }
      const coerced = coerceValue(fd, input);
      if (!coerced.ok) {
        problem(field, coerced.error);
        continue;
      }
      if (
        !lookup &&
        fd.type === 'reference' &&
        coerced.value != null &&
        !referenceMaps.get(field)?.has(keyFor([coerced.value]))
      ) {
        problem(field, 'unresolved reference');
        continue;
      }
      data[field] = coerced.value;
    }
    let before: Row | undefined;
    if (cmd.mode === 'upsert') {
      for (const key of cmd.key ?? [])
        if (data[key] == null || data[key] === '')
          problem(key, 'key value is required');
      const key = keyFor((cmd.key ?? []).map((k) => stored(data[k])));
      if (seenKeys.has(key))
        problem((cmd.key ?? []).join(','), 'duplicate key in load');
      seenKeys.add(key);
      const found = keys.get(key) ?? [];
      if (found.length > 1)
        problem((cmd.key ?? []).join(','), 'ambiguous existing key');
      before = found[0];
    }
    if (!before)
      for (const [field, fd] of Object.entries(fields))
        if (
          fd.required &&
          !fd.calculated &&
          (data[field] == null || data[field] === '')
        )
          problem(field, 'is required');
    // Updating a required field to empty is refused too (same record contract).
    for (const [field, value] of Object.entries(data))
      if (fields[field].required && (value == null || value === ''))
        problem(field, 'is required');
    if (rejected) {
      preview.rejected++;
      continue;
    }
    if (
      before &&
      Object.entries(data).every(([f, value]) =>
        same(stored(value), before?.[snake(f)]),
      )
    ) {
      preview.unchanged++;
      continue;
    }
    if (before) preview.update++;
    else preview.insert++;
    writes.push({
      index,
      data,
      ...(before ? { id: String(before.id), before } : {}),
    });
  }
  return { preview, writes };
}

// A single row journal entry per version/table/id, including NULL originals.
// These entries live in the engine's existing purgeable archive, not app data.
export async function archiveRow(
  db: any,
  version: number,
  model: string,
  id: string,
  before: Row | null,
) {
  const exists = (
    await db.query(
      'SELECT 1 FROM _archive WHERE version = ? AND tbl = ? AND col = ? AND record_id = ?',
      [version, model, '$row', id],
    )
  ).rows.length;
  if (!exists)
    await db.query(
      'INSERT INTO _archive (version, tbl, col, record_id, value, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [
        version,
        model,
        '$row',
        id,
        JSON.stringify(before),
        new Date().toISOString(),
      ],
    );
}
export async function applyLoad(
  def: AppDefinition,
  db: any,
  cmd: LoadRecordsCommand,
  version: number,
  seed: string,
  defaults: Row = {},
) {
  const { preview, writes } = await prepareLoad(def, db, cmd);
  if (preview.rejected)
    throw new AppError(
      `loadRecords rejected ${preview.rejected} rows; no rows loaded`,
    );
  const prepared = writes.map((write) => ({
    ...write,
    id: write.id ?? replayId(seed, String(write.index)),
  }));
  const inserted = prepared.filter((w) => !w.before).map((w) => w.id);
  for (let offset = 0; offset < inserted.length; offset += 500) {
    const ids = inserted.slice(offset, offset + 500);
    if (
      (
        await db.query(
          `SELECT 1 FROM ${quote(tableFor(cmd.model, def.models[cmd.model]))} WHERE id IN (${ids.map(() => '?').join(',')}) LIMIT 1`,
          ids,
        )
      ).rows.length
    )
      throw new AppError('loaded record id already exists');
  }
  // Every input key is unique after preparation. Journal in bounded SDK batches
  // before any record writes, on the same executor and transaction.
  const stamp = new Date().toISOString();
  for (let offset = 0; offset < prepared.length; offset += 100)
    await db.insert(
      '_archive',
      prepared.slice(offset, offset + 100).map((write) => ({
        version,
        tbl: cmd.model,
        col: '$row',
        record_id: write.id,
        value: JSON.stringify(write.before ?? null),
        created_at: stamp,
      })),
    );
  // Bounded savepoint scopes keep the SDK's operation bookkeeping bounded.
  // Releasing a savepoint never commits: any later failure rolls back the one
  // outer migration transaction, including all earlier batches and archives.
  for (let offset = 0; offset < prepared.length; offset += 100) {
    await db.transaction((batch: any) =>
      withCallerOwnedDatabaseTransaction(batch, async () => {
        const collection = await collectionFor(def, batch, cmd.model);
        for (const write of prepared.slice(offset, offset + 100)) {
          if (write.before)
            await collection.update(write.id, write.data as never);
          else
            await collection.create({
              ...defaults,
              ...write.data,
              id: write.id,
            } as never);
        }
        const batchWrites = prepared.slice(offset, offset + 100);
        const byId = new Map(batchWrites.map((write) => [write.id, write]));
        const generated = new Set(
          Object.entries(fieldsOf(def, cmd.model))
            .filter(([, fd]) => fd.calculated)
            .map(([field]) => snake(field)),
        );
        const rows = (
          await batch.query(
            `SELECT * FROM ${quote(tableFor(cmd.model, def.models[cmd.model]))} WHERE id IN (${batchWrites.map(() => '?').join(',')})`,
            batchWrites.map((write) => write.id),
          )
        ).rows as Row[];
        await batch.insert(
          '_archive',
          rows.map((after) => {
            const write = byId.get(String(after.id));
            if (!write)
              throw new AppError('loaded row missing from prepared batch');
            const owned = write.before
              ? Object.fromEntries(
                  Object.entries(after).filter(
                    ([column, value]) =>
                      !same(value, write.before?.[column]) &&
                      !generated.has(column),
                  ),
                )
              : after;
            return {
              version,
              tbl: cmd.model,
              col: '$after',
              record_id: write.id,
              value: JSON.stringify(owned),
              created_at: stamp,
            };
          }),
        );
      }),
    );
  }
  await assertStoredJournalBounds(db, version);
  return preview;
}

/** Save only command-owned columns' postimages; multiple writes share one row. */
export async function archiveAfter(
  db: any,
  version: number,
  model: string,
  id: string,
  after: Row,
) {
  const existing = (
    await db.query(
      "SELECT value FROM _archive WHERE version = ? AND tbl = ? AND col = '$after' AND record_id = ?",
      [version, model, id],
    )
  ).rows[0];
  const value = JSON.stringify({
    ...(existing ? JSON.parse(existing.value) : {}),
    ...after,
  });
  if (existing)
    await db.query(
      "UPDATE _archive SET value = ? WHERE version = ? AND tbl = ? AND col = '$after' AND record_id = ?",
      [value, version, model, id],
    );
  else
    await db.query(
      'INSERT INTO _archive (version, tbl, col, record_id, value, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [version, model, '$after', id, value, new Date().toISOString()],
    );
}

/** Restore owned columns only. Conflicts refuse the entire migration transaction. */
export async function undoRows(def: AppDefinition, db: any, version: number) {
  const entries = (
    await db.query(
      "SELECT tbl, record_id, value FROM _archive WHERE version = ? AND col = '$row' ORDER BY id DESC",
      [version],
    )
  ).rows as Row[];
  const metadata = (
    await db.query(
      "SELECT tbl, record_id, col, value FROM _archive WHERE version = ? AND col IN ('$after', '$deleted')",
      [version],
    )
  ).rows as Row[];
  const post = new Map(
    metadata
      .filter((e) => e.col === '$after')
      .map((e) => [
        `${e.tbl}:${e.record_id}`,
        JSON.parse(String(e.value)) as Row,
      ]),
  );
  const deleted = new Set(
    metadata
      .filter((e) => e.col === '$deleted')
      .map((e) => `${e.tbl}:${e.record_id}`),
  );
  const current = new Map<string, Map<string, Row>>();
  for (const model of new Set(entries.map((e) => String(e.tbl))))
    current.set(
      model,
      new Map(
        (Object.hasOwn(def.models, model)
          ? await rawRows(def, db, model)
          : ((
              await db.query(
                `SELECT * FROM ${quote(tableFor(model, def.models[model]))}`,
              )
            ).rows as Row[])
        ).map((row) => [String(row.id), row]),
      ),
    );
  // Validate all rows before applying any restore. Never resurrect a user deletion,
  // overwrite a reused id, or erase edits even when the caller approved undo.
  for (const entry of entries) {
    const key = `${entry.tbl}:${entry.record_id}`;
    const row = current.get(String(entry.tbl))?.get(String(entry.record_id));
    if (deleted.has(key)) {
      if (row)
        throw new AppError(
          `cannot undo: ${key} removed record id has been reused`,
        );
      continue;
    }
    const after = post.get(key);
    if (!after)
      throw new AppError(`cannot undo: ${key} has no column conflict journal`);
    if (!row)
      throw new AppError(
        `cannot undo: ${key} was deleted since the command; undo would recreate it`,
      );
    for (const [column, value] of Object.entries(after))
      if (column !== 'updated_at' && !same(row[column], value))
        throw new AppError(
          `cannot undo: ${entry.tbl}.${column} on ${entry.record_id} changed since the command; undo would lose that edit`,
        );
  }
  for (const entry of entries) {
    const model = String(entry.tbl);
    const table = tableFor(model, def.models[model]);
    const before = JSON.parse(String(entry.value)) as Row | null;
    const key = `${model}:${entry.record_id}`;
    if (before === null) {
      await db.query(`DELETE FROM ${quote(table)} WHERE id = ?`, [
        entry.record_id,
      ]);
      continue;
    }
    const generated = new Set(
      (
        await db.query(
          'SELECT name FROM pragma_table_xinfo(?) WHERE hidden > 1',
          [table],
        )
      ).rows.map((r: Row) => String(r.name)),
    );
    if (deleted.has(key)) {
      const pairs = Object.entries(before).filter(([f]) => !generated.has(f));
      // Plain INSERT refuses an id reused since the command removed this row.
      await db.query(
        `INSERT INTO ${quote(table)} (${pairs.map(([f]) => quote(f)).join(',')}) VALUES (${pairs.map(() => '?').join(',')})`,
        pairs.map(([, v]) => v),
      );
    } else {
      const after = post.get(key) as Row;
      const row = current.get(model)?.get(String(entry.record_id)) as Row;
      const columns = Object.keys(after).filter(
        (c) =>
          c !== 'id' &&
          !generated.has(c) &&
          (c !== 'updated_at' || same(row[c], after[c])),
      );
      if (columns.length)
        await db.query(
          `UPDATE ${quote(table)} SET ${columns.map((c) => `${quote(c)} = ?`).join(',')} WHERE id = ?`,
          [...columns.map((c) => before[c] ?? null), entry.record_id],
        );
    }
  }
  await db.query(
    "DELETE FROM _archive WHERE version = ? AND col IN ('$row', '$after', '$deleted')",
    [version],
  );
}
