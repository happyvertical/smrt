import type { SmrtClassOptions } from './class';
import type {
  SmrtCollection,
  SmrtListOptions,
  SmrtSelectedRow,
  SmrtSelectField,
} from './collection';
import type { SmrtObject } from './object';
import { ObjectRegistry } from './registry';

type DynamicSmrtObject = SmrtObject & Record<string, unknown>;
type DynamicSmrtListOptions = SmrtListOptions<DynamicSmrtObject>;

/**
 * One independent collection read in a bounded read plan.
 *
 * `ModelType` is optional for dynamic registries. Consumers that know the
 * model type can annotate an entry to retain model/projection result typing.
 */
export interface SmrtCollectionReadPlanEntry<
  ModelType extends SmrtObject = SmrtObject,
  ListOptions extends SmrtListOptions<ModelType> | undefined =
    | SmrtListOptions<ModelType>
    | undefined,
> {
  /** Registered SMRT object or collection name. */
  className: string;
  /** Standard options forwarded unchanged to `SmrtCollection.list()`. */
  options?: ListOptions;
}

/** A keyed group of independent collection reads. */
export type SmrtCollectionReadPlan = Record<
  string,
  {
    className: string;
    options?: DynamicSmrtListOptions;
  }
>;

type SmrtCollectionReadPlanEntryResult<Entry> =
  Entry extends SmrtCollectionReadPlanEntry<infer ModelType, infer ListOptions>
    ? ListOptions extends {
        select: infer Select extends readonly SmrtSelectField<ModelType>[];
      }
      ? SmrtSelectedRow<ModelType, Select>[]
      : ModelType[]
    : never;

/** Results retain the exact keys declared by the input plan. */
export type SmrtCollectionReadPlanResult<Plan extends SmrtCollectionReadPlan> =
  {
    [Key in keyof Plan]: SmrtCollectionReadPlanEntryResult<Plan[Key]>;
  };

export interface ExecuteCollectionReadPlanOptions {
  /**
   * Maximum number of top-level `collection.list()` operations in flight.
   * Must be a positive integer and is intentionally required so callers make
   * workload policy explicit.
   */
  maxConcurrency: number;
  /** Normal options used to resolve every collection in the plan. */
  collectionOptions?: SmrtClassOptions;
}

async function listCollection(
  collection: SmrtCollection<DynamicSmrtObject>,
  options: DynamicSmrtListOptions | undefined,
): Promise<unknown[]> {
  if (options?.select !== undefined) {
    return await collection.list(
      options as DynamicSmrtListOptions & {
        select: readonly SmrtSelectField<DynamicSmrtObject>[];
        include?: never;
      },
    );
  }

  return await collection.list(
    options as
      | (Omit<DynamicSmrtListOptions, 'select'> & {
          select?: undefined;
        })
      | undefined,
  );
}

/**
 * Execute independent collection reads without unbounded database fan-out.
 *
 * Each entry resolves through `ObjectRegistry.getCollection()` and calls the
 * collection's public `list()` method, preserving interceptors, tenancy, STI,
 * hydration, eager loading, projections, and opt-in collection caching.
 *
 * On failure, no additional queued entry is started. Operations that were
 * already in flight are allowed to settle before the first error is rethrown,
 * so the function never leaves detached database work behind.
 *
 * This function does not compose SQL, cache the plan, or change database pool
 * defaults. It only bounds top-level list-operation concurrency.
 */
export async function executeCollectionReadPlan<
  const Plan extends SmrtCollectionReadPlan,
>(
  plan: Plan,
  options: ExecuteCollectionReadPlanOptions,
): Promise<SmrtCollectionReadPlanResult<Plan>> {
  if (
    !Number.isInteger(options.maxConcurrency) ||
    options.maxConcurrency <= 0
  ) {
    throw new RangeError('maxConcurrency must be a positive integer');
  }

  const entries = Object.entries(plan) as [keyof Plan, Plan[keyof Plan]][];

  if (entries.length === 0) {
    return Object.fromEntries([]) as SmrtCollectionReadPlanResult<Plan>;
  }

  let nextIndex = 0;
  let failed = false;
  let firstError: unknown;
  const values: unknown[][] = new Array(entries.length);

  const runWorker = async (): Promise<void> => {
    while (!failed) {
      const entryIndex = nextIndex;
      nextIndex += 1;
      if (entryIndex >= entries.length) return;

      const [, entry] = entries[entryIndex];

      try {
        const collection =
          await ObjectRegistry.getCollection<DynamicSmrtObject>(
            entry.className,
            options.collectionOptions,
          );
        const value = await listCollection(collection, entry.options);
        values[entryIndex] = value;
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
        return;
      }
    }
  };

  const workerCount = Math.min(options.maxConcurrency, entries.length);
  await Promise.all(Array.from({ length: workerCount }, runWorker));

  if (failed) throw firstError;
  return Object.fromEntries(
    entries.map(([key], index) => [key, values[index]]),
  ) as SmrtCollectionReadPlanResult<Plan>;
}
