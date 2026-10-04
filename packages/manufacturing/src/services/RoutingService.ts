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
    const kept = new Set(current.map((step) => step.operationId));
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
      if (!operation.isActive && !kept.has(operation.id as string))
        throw new OperationRetiredError(operation.id as string);
    }

    const write = async (steps: RoutingStepCollection) => {
      for (const step of await steps.findByBom(bomId)) await step.delete();
      const saved: RoutingStep[] = [];
      for (const [index, input] of inputs.entries()) {
        const step = await steps.create({
          bomId,
          operationId: input.operationId,
          sequence: index + 1,
          estimatedMinutes: Number(input.estimatedMinutes),
          notes: input.notes?.trim() ?? '',
        });
        await step.save();
        saved.push(step);
      }
      return saved;
    };

    const underlying = this.db as unknown as TransactionalDb;
    if (typeof underlying.transaction !== 'function') return write(this.steps);
    return underlying.transaction(async (txDb) =>
      write(await RoutingStepCollection.create({ db: txDb as DatabaseConfig })),
    );
  }
}

/** Convenience factory. */
export async function createRoutingService(
  options: RoutingServiceOptions,
): Promise<RoutingService> {
  return RoutingService.create(options);
}
