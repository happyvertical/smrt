/**
 * RoutingService — read and replace the routing of a bill of materials.
 *
 * A routing is the ordered list of {@link RoutingStep} rows for one bill.
 * It is optional; a bill with none is valid. `replaceRouting` swaps the whole
 * list in one transaction, so reordering, inserting and removing steps are one
 * operation and a bill never shows a half-written routing.
 *
 * @packageDocumentation
 */

import { type DatabaseConfig, resolveDatabase } from '@happyvertical/smrt-core';
import { BillOfMaterialsCollection } from '../collections/BillOfMaterialsCollection.js';
import { OperationCollection } from '../collections/OperationCollection.js';
import { RoutingStepCollection } from '../collections/RoutingStepCollection.js';
import type { RoutingStep } from '../models/RoutingStep.js';
import {
  InvalidOperationInputError,
  OperationNotFoundError,
  OperationRetiredError,
  type RoutingStepInput,
} from '../operation-types.js';
import { BomNotFoundError } from '../types.js';

/** Options accepted by {@link RoutingService.create}. */
export interface RoutingServiceOptions {
  db: DatabaseConfig;
}

type TransactionalDb = {
  transaction?: <T>(work: (txDb: unknown) => Promise<T>) => Promise<T>;
};

export class RoutingService {
  private constructor(
    private readonly db: DatabaseConfig,
    public readonly boms: BillOfMaterialsCollection,
    public readonly operations: OperationCollection,
    public readonly steps: RoutingStepCollection,
  ) {}

  /** Factory — prefer {@link createRoutingService}. */
  static async create(options: RoutingServiceOptions): Promise<RoutingService> {
    const db = (await resolveDatabase(options.db)) as unknown as DatabaseConfig;
    const [boms, operations, steps] = await Promise.all([
      BillOfMaterialsCollection.create({ db }),
      OperationCollection.create({ db }),
      RoutingStepCollection.create({ db }),
    ]);
    return new RoutingService(db, boms, operations, steps);
  }

  /** The routing of a bill in step order; empty when it has none. */
  async list(bomId: string): Promise<RoutingStep[]> {
    return this.steps.findByBom(bomId);
  }

  /**
   * Replace the bill's routing with `inputs`, numbered 1..n in the order given.
   * An empty list removes the routing.
   *
   * Throws {@link BomNotFoundError}, {@link OperationNotFoundError},
   * {@link OperationRetiredError} (a retired operation may stay on a routing
   * that already has it but cannot be newly added), or
   * {@link InvalidOperationInputError} for a negative or non-finite duration.
   */
  async replaceRouting(
    bomId: string,
    inputs: readonly RoutingStepInput[],
  ): Promise<RoutingStep[]> {
    if (!bomId || !(await this.boms.get(bomId)))
      throw new BomNotFoundError(bomId);

    const current = await this.steps.findByBom(bomId);
    // Each occurrence already on the routing may be kept once; a retired
    // operation cannot be added beyond the occurrences it already has.
    const retained = new Map<string, number>();
    for (const step of current)
      retained.set(step.operationId, (retained.get(step.operationId) ?? 0) + 1);
    for (const input of inputs) {
      const minutes = Number(input.estimatedMinutes);
      if (!Number.isFinite(minutes) || minutes < 0)
        throw new InvalidOperationInputError(
          'Estimated minutes must be zero or more.',
        );
      const operation = input.operationId
        ? await this.operations.get(input.operationId)
        : null;
      if (!operation) throw new OperationNotFoundError(input.operationId);
      const left = retained.get(operation.id as string) ?? 0;
      if (left > 0) retained.set(operation.id as string, left - 1);
      else if (!operation.isActive)
        throw new OperationRetiredError(operation.id as string);
    }

    const write = async (
      steps: RoutingStepCollection,
      boms: BillOfMaterialsCollection,
    ) => {
      // Serialize replacements of one bill: saving the bill row takes its row
      // lock for the rest of the transaction, so a concurrent replacement
      // waits instead of interleaving. The waiter's revision check then fails;
      // `withRevisionRetry` reruns it against the committed routing.
      const bom = await boms.get(bomId);
      if (!bom) throw new BomNotFoundError(bomId);
      await bom.save();
      for (const step of await steps.findByBom(bomId)) await step.delete();
      const saved: RoutingStep[] = [];
      for (const [index, input] of inputs.entries()) {
        // `create()` persists; no second save.
        saved.push(
          await steps.create({
            bomId,
            operationId: input.operationId,
            sequence: index + 1,
            estimatedMinutes: Number(input.estimatedMinutes),
            notes: input.notes?.trim() ?? '',
          }),
        );
      }
      return saved;
    };

    const underlying = this.db as unknown as TransactionalDb;
    // Delete-and-reinsert is only safe atomically; refuse adapters without it.
    if (typeof underlying.transaction !== 'function')
      throw new Error(
        'RoutingService requires a database adapter with transaction() support.',
      );
    return withRevisionRetry(
      () =>
        underlying.transaction?.(async (txDb) => {
          const db = txDb as DatabaseConfig;
          return write(
            await RoutingStepCollection.create({ db }),
            await BillOfMaterialsCollection.create({ db }),
          );
        }) as Promise<RoutingStep[]>,
    );
  }
}

/**
 * Rerun a whole routing transaction when it lost the bill's revision race to a
 * concurrent replacement; the rerun reads the routing the winner committed.
 */
async function withRevisionRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      if (code !== 'RUNTIME_REVISION_CONFLICT' || attempt >= 5) throw error;
    }
  }
}

/** Convenience factory. */
export async function createRoutingService(
  options: RoutingServiceOptions,
): Promise<RoutingService> {
  return RoutingService.create(options);
}
