// Replayable data commands. Every handle here is the boot migration's executor;
// previews use a read transaction and the same preparation path as apply.
import { createHash } from 'node:crypto';
import { ObjectRegistry } from '@happyvertical/smrt-core';
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
export const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;
export const fieldsOf = (def: AppDefinition, model: string) => {
  const md = def.models[model];
  if (!md) throw new AppError(`no model ${model}`);
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
export async function prepareLoad(
  def: AppDefinition,
  db: any,
  cmd: LoadRecordsCommand,
) {
  if (!Array.isArray(cmd.rows) || cmd.rows.length > LOAD_LIMITS.rows)
    throw new AppError(`loadRecords accepts at most ${LOAD_LIMITS.rows} rows`);
  let bytes: number;
  try {
    bytes = Buffer.byteLength(JSON.stringify(cmd.rows));
  } catch {
    throw new AppError('loadRecords needs JSON rows');
  }
  if (bytes > LOAD_LIMITS.bytes)
    throw new AppError(
      `loadRecords accepts at most ${LOAD_LIMITS.bytes} bytes`,
    );
  if (!['insert', 'upsert'].includes(cmd.mode))
    throw new AppError('loadRecords mode must be insert or upsert');
  const fields = fieldsOf(def, cmd.model);
  if (cmd.mode === 'upsert' && (!Array.isArray(cmd.key) || !cmd.key.length))
    throw new AppError('upsert needs key fields');
  for (const key of cmd.key ?? [])
    if (!fields[key] || fields[key].calculated)
      throw new AppError(`invalid key field '${key}'`);
  const lookups = new Map<string, Row[]>();
  const referenceMaps = new Map<string, Map<string, string[]>>();
  for (const [field, lookup] of Object.entries(cmd.references ?? {})) {
    if (
      !lookup ||
      fields[field]?.type !== 'reference' ||
      fields[field].ref !== lookup.model
    )
      throw new AppError(`invalid reference lookup '${field}'`);
    const target = fieldsOf(def, lookup.model)[lookup.by];
    if (!target || target.calculated)
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
      const fd = fields[field];
      if (!fd) {
        problem(field, 'unknown or hidden field');
        continue;
      }
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
) {
  const { preview, writes } = await prepareLoad(def, db, cmd);
  if (preview.rejected)
    throw new AppError(
      `loadRecords rejected ${preview.rejected} rows; no rows loaded`,
    );
  const collection = await collectionFor(def, db, cmd.model);
  for (const write of writes) {
    const id = write.id ?? replayId(seed, String(write.index));
    if (
      !write.before &&
      (
        await db.query(
          `SELECT 1 FROM ${quote(tableFor(cmd.model, def.models[cmd.model]))} WHERE id = ?`,
          [id],
        )
      ).rows.length
    )
      throw new AppError('loaded record id already exists');
    await archiveRow(db, version, cmd.model, id, write.before ?? null);
    if (write.before) await collection.update(id, write.data as never);
    else await collection.create({ ...write.data, id } as never);
  }
  return preview;
}

/** Restore the exact stored rows, omitting database-owned generated columns. */
export async function undoRows(def: AppDefinition, db: any, version: number) {
  const entries = (
    await db.query(
      "SELECT tbl, record_id, value FROM _archive WHERE version = ? AND col = '$row' ORDER BY id DESC",
      [version],
    )
  ).rows as Row[];
  for (const entry of entries) {
    const model = String(entry.tbl);
    const table = tableFor(model, def.models[model]);
    const before = JSON.parse(String(entry.value)) as Row | null;
    if (before === null) {
      await db.query(`DELETE FROM ${quote(table)} WHERE id = ?`, [
        entry.record_id,
      ]);
      continue;
    }
    const generated = new Set(
      Object.entries(fieldsOf(def, model))
        .filter(([, f]) => f.calculated)
        .map(([f]) => snake(f)),
    );
    const pairs = Object.entries(before).filter(([f]) => !generated.has(f));
    // Refuse a conflicting id reused since a merged row was removed.
    await db.query(
      `INSERT INTO ${quote(table)} (${pairs.map(([f]) => quote(f)).join(',')}) VALUES (${pairs.map(() => '?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${pairs
        .filter(([f]) => f !== 'id')
        .map(([f]) => `${quote(f)} = excluded.${quote(f)}`)
        .join(',')}`,
      pairs.map(([, v]) => v),
    );
  }
  await db.query("DELETE FROM _archive WHERE version = ? AND col = '$row'", [
    version,
  ]);
}
