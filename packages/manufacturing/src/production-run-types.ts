/**
 * Inputs, results and errors for `ProductionRunService`.
 *
 * @packageDocumentation
 */

import type { ProductionRun } from './models/ProductionRun.js';
import type { ProductionRunCompletion } from './models/ProductionRunCompletion.js';
import type {
  ConsumeResult,
  ProduceResult,
} from './services/ProductionService.js';

/** Input for `ProductionRunService.createRun`. Give `bomId`, or `productId` for its active bill. */
export interface CreateProductionRunInput {
  /** The bill to build against. Wins over `productId`. */
  bomId?: string;
  /** A product (usually an `Assembly`) whose active bill the run pins. */
  productId?: string;
  /** Units to build; greater than zero. */
  targetQty: number;
}

/** Stock to consume when a completion is recorded: the run's bill, for the completed units. */
export interface CompletionConsumeOptions {
  /** Location the components are taken from. */
  locationId: string;
  /** Optional free-form note on each movement. */
  note?: string;
}

/** Finished goods to receive when a completion is recorded. */
export interface CompletionProduceOptions {
  /** Location the finished units are received into. */
  locationId: string;
  /** The SKU of the bill's product that was built. */
  finishedSkuId: string;
  /** Optional free-form note on the movement. */
  note?: string;
}

/** Input for `ProductionRunService.recordCompletion`. */
export interface RecordCompletionInput {
  /** Units finished; greater than zero and no more than the run has left. */
  qty: number;
  /** When they were finished. Defaults to now. */
  completedAt?: Date | string;
  /**
   * Consume the run's bill for `qty` units, in the same transaction. Omit
   * (the default) to record progress without touching stock.
   */
  consume?: CompletionConsumeOptions;
  /**
   * Receive `qty` finished units, in the same transaction. Omit (the
   * default) to record progress without touching stock.
   */
  produce?: CompletionProduceOptions;
}

/** Result of `ProductionRunService.recordCompletion`. */
export interface RecordCompletionResult {
  /** The run after the completion. */
  run: ProductionRun;
  /** The completion that was recorded. */
  completion: ProductionRunCompletion;
  /** Components consumed; empty unless `consume` was given. */
  consumed: ConsumeResult[];
  /** Finished goods received; `null` unless `produce` was given. */
  produced: ProduceResult | null;
}

/** Thrown when a production run id does not exist. */
export class ProductionRunNotFoundError extends Error {
  override name = 'ProductionRunNotFoundError';

  constructor(public readonly runId: string) {
    super(`Production run not found: ${runId}`);
  }
}

/** Thrown when an action is not allowed in the run's current status. */
export class ProductionRunStateError extends Error {
  override name = 'ProductionRunStateError';

  constructor(
    public readonly runId: string,
    /** The run's status when the action was refused. */
    public readonly status: string,
    /** What was attempted: `start`, `complete`, `finish`, `cancel`, `retarget`. */
    public readonly action: string,
  ) {
    super(`Production run ${runId} is ${status}; cannot ${action} it.`);
  }
}

/** Thrown when a completion would take the run past its target. */
export class ProductionRunOverCompletionError extends Error {
  override name = 'ProductionRunOverCompletionError';

  constructor(
    public readonly runId: string,
    /** The quantity reported. */
    public readonly qty: number,
    /** What the run had left to build. */
    public readonly remaining: number,
  ) {
    super(
      `Production run ${runId} has ${remaining} left to build; cannot report ${qty}.`,
    );
  }
}

/** Thrown for invalid production run input (quantities, dates, bill). */
export class InvalidProductionRunInputError extends Error {
  override name = 'InvalidProductionRunInputError';
}
