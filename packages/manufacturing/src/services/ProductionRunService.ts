/**
 * ProductionRunService — create production runs and report work on them as
 * it happens: "25 to build, 12 done".
 *
 * Every write runs in one database transaction that first saves the run
 * row. That save is revision-guarded, so it takes the row's lock and a
 * concurrent writer's save fails with a revision conflict; the loser's whole
 * transaction is retried against the committed run. Two people reporting
 * completions at once therefore both count, and a run never goes past its
 * target.
 *
 * Recording a completion moves no stock unless the caller asks. With
 * `consume` and/or `produce`, it uses the {@link ProductionService} paths
 * inside the same transaction as the completion, so a stock shortfall rolls
 * the completion back too.
 *
 * @packageDocumentation
 */

import { type DatabaseConfig, resolveDatabase } from '@happyvertical/smrt-core';
import {
  createStockService,
  type StockService,
} from '@happyvertical/smrt-inventory';
import { BillOfMaterialsCollection } from '../collections/BillOfMaterialsCollection.js';
import { ProductionRunCollection } from '../collections/ProductionRunCollection.js';
import { ProductionRunCompletionCollection } from '../collections/ProductionRunCompletionCollection.js';
import type { ProductionRun } from '../models/ProductionRun.js';
import type { ProductionRunCompletion } from '../models/ProductionRunCompletion.js';
import {
  type CreateProductionRunInput,
  InvalidProductionRunInputError,
  ProductionRunNotFoundError,
  ProductionRunOverCompletionError,
  ProductionRunStateError,
  type RecordCompletionInput,
  type RecordCompletionResult,
} from '../production-run-types.js';
import { roundQuantity } from '../quantity.js';
import { BomNotFoundError, NoActiveBomForProductError } from '../types.js';
import {
  type ConsumeResult,
  type ProduceResult,
  ProductionService,
} from './ProductionService.js';

/**
 * Options accepted by {@link ProductionRunService.create}. With a
 * `stockService`, its database is used for everything, so a completion and
 * its stock movements share one transaction.
 */
export type ProductionRunServiceOptions =
  | { db: DatabaseConfig; stockService?: undefined }
  | { stockService: StockService; db?: undefined };

type TransactionalDb = {
  transaction?: <T>(work: (txDb: unknown) => Promise<T>) => Promise<T>;
};

/** Collections bound to one open transaction. */
interface RunTransaction {
  stock: StockService;
  runs: ProductionRunCollection;
  completions: ProductionRunCompletionCollection;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Statuses in which work can still be reported or the run changed. */
const OPEN_STATUSES = new Set(['planned', 'in_progress']);

/**
 * Creates runs and records their progress. Construct with
 * {@link ProductionRunService.create} or {@link createProductionRunService}.
 *
 * @example
 * ```typescript
 * const runs = await ProductionRunService.create({ db });
 * const run = await runs.createRun({ productId: frame.id, targetQty: 25 });
 * await runs.recordCompletion(run.id!, { qty: 12 });
 * // run: 25 to build, 12 done, in_progress
 * ```
 */
export class ProductionRunService {
  private constructor(
    /** The stock service whose database every collection here shares. */
    public readonly stockService: StockService,
    /** Production runs (reads; writes go through this service). */
    public readonly runs: ProductionRunCollection,
    /** Completions (reads; writes go through this service). */
    public readonly completions: ProductionRunCompletionCollection,
    /** Bills, to pin a run's bill. */
    public readonly boms: BillOfMaterialsCollection,
  ) {}

  /** Factory — prefer {@link createProductionRunService}. */
  static async create(
    options: ProductionRunServiceOptions,
  ): Promise<ProductionRunService> {
    let stockService = options.stockService;
    if (!stockService) {
      if (!options.db)
        throw new Error(
          'ProductionRunService.create: either `db` or `stockService` is required',
        );
      // Resolve once so the stock service and every collection share one
      // handle: a config such as `:memory:` would otherwise open a database
      // per collection.
      const resolved = (await resolveDatabase(
        options.db,
      )) as unknown as DatabaseConfig;
      stockService = await createStockService({ db: resolved });
    }
    const db = stockService.db;
    // Recording a completion is atomic only inside a transaction; refuse an
    // adapter that cannot open one rather than writing step by step.
    if (typeof (db as unknown as TransactionalDb).transaction !== 'function')
      throw new Error(
        'ProductionRunService requires a database adapter with transaction() support.',
      );
    const [runs, completions, boms] = await Promise.all([
      ProductionRunCollection.create({ db }),
      ProductionRunCompletionCollection.create({ db }),
      BillOfMaterialsCollection.create({ db }),
    ]);
    return new ProductionRunService(stockService, runs, completions, boms);
  }

  /**
   * Create a `planned` run of `targetQty` units, pinned to `bomId`, or to the
   * active bill of `productId`.
   *
   * @throws {InvalidProductionRunInputError} for a target that is not a
   *   positive number, or when neither `bomId` nor `productId` is given.
   * @throws {BomNotFoundError} when `bomId` does not exist.
   * @throws {NoActiveBomForProductError} when `productId` has no active bill.
   */
  async createRun(input: CreateProductionRunInput): Promise<ProductionRun> {
    const targetQty = positive(input.targetQty, 'targetQty');
    let bomId = input.bomId;
    if (bomId) {
      if (!UUID_PATTERN.test(bomId) || !(await this.boms.get({ id: bomId })))
        throw new BomNotFoundError(bomId);
    } else if (input.productId) {
      const active = await this.boms.findActiveForProduct(input.productId);
      if (!active?.id) throw new NoActiveBomForProductError(input.productId);
      bomId = active.id;
    } else {
      throw new InvalidProductionRunInputError(
        'A production run needs a bomId or a productId.',
      );
    }
    // `create()` persists; no second save.
    return this.runs.create({
      bomId,
      targetQty,
      completedQty: 0,
      status: 'planned',
    });
  }

  /** The run, or `null` when no run has this id. */
  async get(runId: string): Promise<ProductionRun | null> {
    if (!UUID_PATTERN.test(runId)) return null;
    return this.runs.get({ id: runId });
  }

  /** A run's completions in the order they happened. */
  async listCompletions(runId: string): Promise<ProductionRunCompletion[]> {
    if (!UUID_PATTERN.test(runId)) return [];
    return this.completions.findByRun(runId);
  }

  /** Mark a `planned` run `in_progress`. */
  async start(runId: string): Promise<ProductionRun> {
    return this.change(runId, 'start', (run) => {
      if (run.status !== 'planned')
        throw new ProductionRunStateError(runId, run.status, 'start');
      run.status = 'in_progress';
    });
  }

  /** Mark an open run `done`, short of its target if work stopped early. */
  async finish(runId: string): Promise<ProductionRun> {
    return this.change(runId, 'finish', (run) => {
      run.status = 'done';
    });
  }

  /** Cancel an open run. Completions already reported stay. */
  async cancel(runId: string): Promise<ProductionRun> {
    return this.change(runId, 'cancel', (run) => {
      run.status = 'cancelled';
    });
  }

  /**
   * Change an open run's target. It may not go below what is already done;
   * setting it to exactly that finishes the run.
   *
   * @throws {InvalidProductionRunInputError} for a target that is not a
   *   positive number or is below the completed quantity.
   */
  async setTarget(runId: string, targetQty: number): Promise<ProductionRun> {
    const target = positive(targetQty, 'targetQty');
    return this.change(runId, 'retarget', (run) => {
      const completed = roundQuantity(Number(run.completedQty));
      if (target < completed)
        throw new InvalidProductionRunInputError(
          `The target cannot be below the ${completed} already done.`,
        );
      run.targetQty = target;
      if (completed > 0 && completed >= target) run.status = 'done';
    });
  }

  /**
   * Report `qty` finished units on an open run: records a dated completion,
   * adds it to `completedQty`, moves a `planned` run to `in_progress`, and
   * marks the run `done` when the target is reached. With `consume` and/or
   * `produce`, also writes the stock movements through
   * {@link ProductionService}, stamped `sourceType: 'ProductionRunCompletion'`
   * with the completion id. Everything runs in one transaction.
   *
   * Consumption takes the run's bill's own lines for `qty` units: a
   * sub-assembly on the bill is taken from stock as a component. Building
   * that sub-assembly is its own run.
   *
   * @throws {ProductionRunNotFoundError}
   * @throws {ProductionRunStateError} when the run is `done` or `cancelled`.
   * @throws {ProductionRunOverCompletionError} when `qty` is more than the
   *   run has left.
   * @throws {InvalidProductionRunInputError} for a bad `qty` or date.
   * @throws `InsufficientStockError` from inventory when consuming would
   *   drive stock below zero; nothing is recorded then.
   */
  async recordCompletion(
    runId: string,
    input: RecordCompletionInput,
  ): Promise<RecordCompletionResult> {
    const qty = positive(input.qty, 'qty');
    const completedAt =
      input.completedAt === undefined
        ? new Date()
        : new Date(input.completedAt);
    if (Number.isNaN(completedAt.getTime()))
      throw new InvalidProductionRunInputError(
        'completedAt is not a valid date.',
      );

    return this.inTransaction(async (tx) => {
      const run = await this.load(tx, runId);
      if (!OPEN_STATUSES.has(run.status))
        throw new ProductionRunStateError(runId, run.status, 'complete');
      // Rounded to the quantity precision and compared exactly.
      const target = roundQuantity(Number(run.targetQty));
      const done = roundQuantity(Number(run.completedQty));
      const total = roundQuantity(done + qty);
      if (total > target)
        throw new ProductionRunOverCompletionError(
          runId,
          qty,
          roundQuantity(Math.max(0, target - done)),
        );
      run.completedQty = total;
      run.status = total >= target ? 'done' : 'in_progress';
      // Revision-guarded: a concurrent report fails here and is retried.
      await run.save();
      // `create()` persists; no second save.
      const completion = await tx.completions.create({
        runId,
        qty,
        completedAt,
      });

      let consumed: ConsumeResult[] = [];
      let produced: ProduceResult | null = null;
      if (input.consume || input.produce) {
        // Bound to the open transaction: its own withTransaction joins it.
        const production = await ProductionService.create({
          stockService: tx.stock,
        });
        const ref = { id: completion.id, bomId: run.bomId };
        const sourceType = 'ProductionRunCompletion';
        const consume = input.consume && {
          ...input.consume,
          qty,
          sourceType,
        };
        const produce = input.produce && {
          ...input.produce,
          qty,
          sourceType,
        };
        if (consume && produce) {
          ({ consumed, produced } = await production.runProduction(ref, {
            consume,
            produce,
          }));
        } else if (consume) {
          consumed = await production.consumeMaterials(ref, consume);
        } else if (produce) {
          produced = await production.produceFinishedGoods(ref, produce);
        }
      }
      return { run, completion, consumed, produced };
    });
  }

  /** Apply `apply` to an open run and save it, in one transaction. */
  private change(
    runId: string,
    action: string,
    apply: (run: ProductionRun) => void,
  ): Promise<ProductionRun> {
    return this.inTransaction(async (tx) => {
      const run = await this.load(tx, runId);
      if (!OPEN_STATUSES.has(run.status))
        throw new ProductionRunStateError(runId, run.status, action);
      apply(run);
      await run.save();
      return run;
    });
  }

  private async load(
    tx: RunTransaction,
    runId: string,
  ): Promise<ProductionRun> {
    const run = UUID_PATTERN.test(runId)
      ? await tx.runs.get({ id: runId })
      : null;
    if (!run) throw new ProductionRunNotFoundError(runId);
    return run;
  }

  /**
   * Run `work` in one transaction on collections bound to it, rerunning the
   * whole transaction when it lost a revision race on the run row.
   */
  private inTransaction<T>(
    work: (tx: RunTransaction) => Promise<T>,
  ): Promise<T> {
    return withRevisionRetry(() =>
      this.stockService.withTransaction(async (stock) => {
        const db = stock.db;
        const [runs, completions] = await Promise.all([
          ProductionRunCollection.create({ db }),
          ProductionRunCompletionCollection.create({ db }),
        ]);
        return work({ stock, runs, completions });
      }),
    );
  }
}

/** Retries allowed for one write that keeps losing the run row's revision race. */
const MAX_REVISION_ATTEMPTS = 10;

async function withRevisionRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (
        code !== 'RUNTIME_REVISION_CONFLICT' ||
        attempt >= MAX_REVISION_ATTEMPTS
      )
        throw error;
    }
  }
}

/**
 * `value` as a quantity: finite, rounded to the quantity precision, and
 * greater than zero after rounding.
 */
function positive(value: number, field: string): number {
  const raw = Number(value);
  const number = Number.isFinite(raw) ? roundQuantity(raw) : raw;
  if (!Number.isFinite(number) || number <= 0)
    throw new InvalidProductionRunInputError(
      `${field} must be a number greater than zero (got ${String(value)}).`,
    );
  return number;
}

/** Convenience factory for {@link ProductionRunService}. */
export function createProductionRunService(
  options: ProductionRunServiceOptions,
): Promise<ProductionRunService> {
  return ProductionRunService.create(options);
}
