import type { CatalogModel } from '../catalog/types.ts';
import { fakeId, fakeRecords, type ModelRecord } from './fakes.ts';

export type { ModelRecord } from './fakes.ts';

/**
 * Where the generated views read and write rows. Everything is async so the
 * in-memory fakes here can later be swapped for live s-m-r-t collections
 * without touching a view.
 */
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
}

/** Deterministic seeded fakes held in memory, lazily per model. */
export function createMemoryDataSource(
  options: MemoryDataSourceOptions = {},
): DataSource {
  const seed = options.seed ?? 1;
  const rows = options.rowsPerModel ?? 8;
  const tables = new Map<string, ModelRecord[]>();
  let created = 0;

  const table = (model: CatalogModel): ModelRecord[] => {
    let existing = tables.get(model.id);
    if (!existing) {
      existing = fakeRecords(model, rows, seed);
      tables.set(model.id, existing);
    }
    return existing;
  };

  const present = (model: CatalogModel, record: ModelRecord): ModelRecord => ({
    ...record,
    ...(options.defaults?.(model) ?? {}),
  });

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
        id: fakeId(`${model.id}:new:${seed}:${created++}`),
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
  };
}
