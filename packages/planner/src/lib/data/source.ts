import type { CatalogModel } from '../catalog/types.ts';
import {
  fakeId,
  fakeRecords,
  type ModelRecord,
  SAMPLE_ROW_COUNTS,
} from './fakes.ts';

export type { ModelRecord } from './fakes.ts';

/**
 * Where the generated views read and write rows. Everything is async so the
 * in-memory fakes here can later be swapped for live s-m-r-t collections
 * without touching a view.
 */
/**
 * The id of an earlier write in the same {@link DataSource.apply}, by alias; or,
 * with `field`, that row's value of that field (a Customer's `profileId`).
 */
export interface RecordRef {
  ref: string;
  field?: string;
}

/** A plain JSON object, e.g. an Address; never a {@link RecordRef}. */
export type JsonObject = { readonly [key: string]: unknown };

export type WriteValue =
  | string
  | number
  | boolean
  | null
  | RecordRef
  | JsonObject;

export function isRecordRef(value: unknown): value is RecordRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as RecordRef).ref === 'string'
  );
}

/**
 * One step of a multi-model save. `save` updates the row `id`; without an `id`
 * it finds the row whose fields equal `match` (creating it from `match`,
 * `onCreate` and `values` when none does), and without either it creates one. `delete`
 * removes the row `id`, or every row equal to `match`.
 */
export type RecordWrite =
  | {
      op: 'save';
      /** Names the written row so a later step can `{ref}` its id. */
      as?: string;
      model: CatalogModel;
      id?: string;
      match?: Record<string, WriteValue>;
      values?: Record<string, WriteValue>;
      /** Extra values applied only when the row is created, not when found. */
      onCreate?: Record<string, WriteValue>;
    }
  | {
      op: 'delete';
      model: CatalogModel;
      id?: string;
      match?: Record<string, WriteValue>;
    };

export interface DataSource {
  list(model: CatalogModel): Promise<ModelRecord[]>;
  get(model: CatalogModel, id: string): Promise<ModelRecord | undefined>;
  create(
    model: CatalogModel,
    values: Record<string, unknown>,
  ): Promise<ModelRecord>;
  update(
    model: CatalogModel,
    id: string,
    values: Record<string, unknown>,
  ): Promise<ModelRecord | undefined>;
  delete(model: CatalogModel, id: string): Promise<boolean>;
  /**
   * Related multi-model saves, all or nothing: the steps run in order and if
   * one fails (an unknown `{ref}`, a missing row to update) none is kept.
   * Returns the rows written, by alias.
   */
  apply(writes: readonly RecordWrite[]): Promise<Record<string, ModelRecord>>;
}

export interface MemoryDataSourceOptions {
  /** Seed for the sample data; the same seed gives the same rows. */
  seed?: number;
  /** Rows generated per model on first read. */
  rowsPerModel?: number;
  /**
   * Values every row of a model carries whatever the form shows, e.g. the
   * `contractType` discriminator of a model in a shared table. Read each time
   * a row is read or created, so it follows the current recipe options.
   */
  defaults?: (model: CatalogModel) => Record<string, unknown>;
  /**
   * Qualified model names that start empty instead of with sample rows:
   * models whose rows only make sense under a parent a form creates (SKUs,
   * stock), where random rows would point at nothing.
   */
  empty?: readonly string[];
}

/** Deterministic seeded fakes held in memory, lazily per model. */
export function createMemoryDataSource(
  options: MemoryDataSourceOptions = {},
): DataSource {
  const seed = options.seed ?? 1;
  const rows = options.rowsPerModel ?? 8;
  const empty = new Set(options.empty ?? []);
  const tables = new Map<string, ModelRecord[]>();
  let created = 0;

  const table = (model: CatalogModel): ModelRecord[] => {
    let existing = tables.get(model.id);
    if (!existing) {
      existing = empty.has(model.id)
        ? []
        : fakeRecords(model, SAMPLE_ROW_COUNTS[model.id] ?? rows, seed);
      tables.set(model.id, existing);
    }
    return existing;
  };

  const present = (model: CatalogModel, record: ModelRecord): ModelRecord => ({
    ...record,
    ...(options.defaults?.(model) ?? {}),
  });

  const nextId = (model: CatalogModel) =>
    fakeId(`${model.id}:new:${seed}:${created++}`);

  const matches = (record: ModelRecord, match: Record<string, unknown>) =>
    Object.entries(match).every(([key, value]) => record[key] === value);

  return {
    async list(model) {
      return table(model).map((r) => present(model, r));
    },
    async get(model, id) {
      const found = table(model).find((r) => r.id === id);
      return found ? present(model, found) : undefined;
    },
    async create(model, values) {
      const record: ModelRecord = {
        ...(options.defaults?.(model) ?? {}),
        ...values,
        id: nextId(model),
      };
      table(model).push(record);
      return { ...record };
    },
    async update(model, id, values) {
      const list = table(model);
      const index = list.findIndex((r) => r.id === id);
      if (index < 0) return undefined;
      const next: ModelRecord = { ...list[index], ...values, id };
      list[index] = next;
      return { ...next };
    },
    async delete(model, id) {
      const list = table(model);
      const index = list.findIndex((r) => r.id === id);
      if (index < 0) return false;
      list.splice(index, 1);
      return true;
    },
    async apply(writes) {
      // Snapshot every table a step touches; restore them all if one throws.
      const snapshots = new Map<string, ModelRecord[]>();
      const counter = created;
      const touch = (model: CatalogModel) => {
        const rows = table(model);
        if (!snapshots.has(model.id)) {
          snapshots.set(
            model.id,
            rows.map((r) => ({ ...r })),
          );
        }
        return rows;
      };
      const written: Record<string, ModelRecord> = {};
      const resolve = (
        values: Record<string, WriteValue> | undefined,
      ): Record<string, unknown> =>
        Object.fromEntries(
          Object.entries(values ?? {}).map(([key, value]) => {
            if (!isRecordRef(value)) return [key, value];
            const target = written[value.ref];
            if (!target)
              throw new Error(`Unknown record reference ${value.ref}`);
            return [key, value.field ? target[value.field] : target.id];
          }),
        );

      try {
        for (const write of writes) {
          const list = touch(write.model);
          const match = resolve(write.match);
          if (write.op === 'delete') {
            const doomed = list.filter((r) =>
              write.id !== undefined ? r.id === write.id : matches(r, match),
            );
            if (write.id === undefined && Object.keys(match).length === 0) {
              throw new Error('A delete needs an id or a match');
            }
            for (const record of doomed) {
              list.splice(list.indexOf(record), 1);
            }
            continue;
          }
          const values = resolve(write.values);
          let index = -1;
          if (write.id !== undefined) {
            index = list.findIndex((r) => r.id === write.id);
            if (index < 0) {
              throw new Error(`No ${write.model.name} with id ${write.id}`);
            }
          } else if (Object.keys(match).length > 0) {
            index = list.findIndex((r) => matches(r, match));
          }
          let record: ModelRecord;
          if (index >= 0) {
            const current = list[index] as ModelRecord;
            record = { ...current, ...values, id: current.id };
            list[index] = record;
          } else {
            record = {
              ...(options.defaults?.(write.model) ?? {}),
              ...match,
              ...resolve(write.onCreate),
              ...values,
              id: nextId(write.model),
            };
            list.push(record);
          }
          if (write.as) written[write.as] = { ...record };
        }
      } catch (error) {
        for (const [id, rows] of snapshots) tables.set(id, rows);
        created = counter;
        throw error;
      }
      return written;
    },
  };
}
