import {
  archiveRow,
  fieldsOf,
  quote,
  type Row,
  rawRows,
  undoRows,
} from './data-migrations.ts';
import type { AppDefinition } from './definition.ts';
import { snake, tableFor } from './definition.ts';
import { AppError } from './errors.ts';

export interface MergeRecordsCommand {
  type: 'mergeRecords';
  model: string;
  keep: string;
  merge: string[];
  fields?: Record<string, 'keep' | string>;
}
export interface MergePreview {
  removed: number;
  references: Record<string, number>;
}
export async function prepareMerge(
  def: AppDefinition,
  db: any,
  cmd: MergeRecordsCommand,
) {
  const fields = fieldsOf(def, cmd.model);
  if (
    typeof cmd.keep !== 'string' ||
    !Array.isArray(cmd.merge) ||
    !cmd.merge.length ||
    cmd.merge.length > 1000 ||
    cmd.merge.some((id) => typeof id !== 'string' || id === cmd.keep) ||
    new Set(cmd.merge).size !== cmd.merge.length
  )
    throw new AppError(
      'mergeRecords needs keep and 1-1000 distinct other record ids',
    );
  const rows = await rawRows(def, db, cmd.model);
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const keep = byId.get(cmd.keep);
  if (!keep || cmd.merge.some((id) => !byId.has(id)))
    throw new AppError('merge record not found');
  const chosen: Row = {};
  for (const [field, selector] of Object.entries(cmd.fields ?? {})) {
    if (!Object.hasOwn(fields, field) || fields[field].calculated)
      throw new AppError(`merge field '${field}' is not writable`);
    if (
      selector !== 'keep' &&
      selector !== cmd.keep &&
      !cmd.merge.includes(selector)
    )
      throw new AppError(
        `merge selector for '${field}' is not one of these records`,
      );
    chosen[snake(field)] = (selector === 'keep' ? keep : byId.get(selector))?.[
      snake(field)
    ];
  }
  const ids = new Set(cmd.merge);
  const references: Record<string, number> = {};
  const changes: { model: string; row: Row; columns: string[] }[] = [];
  for (const [model, md] of Object.entries(def.models)) {
    const refs = Object.entries(md.fields).filter(
      ([, f]) => f.type === 'reference' && f.ref === cmd.model,
    );
    if (!refs.length) continue;
    const referring =
      model === cmd.model ? rows : await rawRows(def, db, model);
    for (const row of referring) {
      const effective =
        model === cmd.model && row.id === cmd.keep
          ? { ...row, ...chosen }
          : row;
      const columns = refs
        .filter(([field]) => ids.has(String(effective[snake(field)])))
        .map(([field]) => snake(field));
      if (!columns.length) continue;
      references[model] = (references[model] ?? 0) + columns.length;
      changes.push({ model, row, columns });
    }
  }
  return {
    keep,
    byId,
    chosen,
    changes,
    preview: { removed: cmd.merge.length, references } satisfies MergePreview,
  };
}
export async function applyMerge(
  def: AppDefinition,
  db: any,
  cmd: MergeRecordsCommand,
  version: number,
) {
  const { keep, byId, chosen, changes } = await prepareMerge(def, db, cmd);
  const table = quote(tableFor(cmd.model, def.models[cmd.model]));
  if (Object.keys(chosen).length) {
    await archiveRow(db, version, cmd.model, cmd.keep, keep);
    await db.query(
      `UPDATE ${table} SET ${Object.keys(chosen)
        .map((c) => `${quote(c)} = ?`)
        .join(',')} WHERE id = ?`,
      [...Object.values(chosen), cmd.keep],
    );
  }
  for (const change of changes) {
    await archiveRow(
      db,
      version,
      change.model,
      String(change.row.id),
      change.row,
    );
    await db.query(
      `UPDATE ${quote(tableFor(change.model, def.models[change.model]))} SET ${change.columns.map((c) => `${quote(c)} = ?`).join(',')} WHERE id = ?`,
      [...change.columns.map(() => cmd.keep), change.row.id],
    );
  }
  for (const id of cmd.merge) {
    await archiveRow(db, version, cmd.model, id, byId.get(id) as Row);
    await db.query(
      'INSERT INTO _archive (version, tbl, col, record_id, value, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [version, cmd.model, '$deleted', id, '', new Date().toISOString()],
    );
    await db.query(`DELETE FROM ${table} WHERE id = ?`, [id]);
  }
}
export async function undoMerge(
  def: AppDefinition,
  db: any,
  cmd: MergeRecordsCommand,
  version: number,
) {
  const current = await rawRows(def, db, cmd.model);
  if (current.some((row) => cmd.merge.includes(String(row.id))))
    throw new AppError(
      'cannot undo merge: a removed record id has been reused',
    );
  await undoRows(def, db, version);
  await db.query(
    "DELETE FROM _archive WHERE version = ? AND col = '$deleted'",
    [version],
  );
}
