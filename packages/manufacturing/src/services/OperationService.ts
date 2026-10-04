/**
 * OperationService — maintain the managed list of {@link Operation} rows:
 * define, rename, change category or required qualification, retire and
 * reinstate. Operations are never deleted.
 *
 * @packageDocumentation
 */

import type { DatabaseConfig } from '@happyvertical/smrt-core';
import { OperationCollection } from '../collections/OperationCollection.js';
import type { Operation } from '../models/Operation.js';
import {
  type DefineOperationInput,
  DuplicateOperationCodeError,
  InvalidOperationInputError,
  OperationNotFoundError,
} from '../operation-types.js';

/** Options accepted by {@link OperationService.create}. */
export interface OperationServiceOptions {
  db: DatabaseConfig;
}

export class OperationService {
  private constructor(public readonly operations: OperationCollection) {}

  /** Factory — prefer {@link createOperationService}. */
  static async create(
    options: OperationServiceOptions,
  ): Promise<OperationService> {
    return new OperationService(
      await OperationCollection.create({ db: options.db }),
    );
  }

  /**
   * Add an operation. The code is trimmed and must be unique per tenant;
   * throws {@link DuplicateOperationCodeError} when it is taken (retired
   * operations keep their code).
   */
  async define(input: DefineOperationInput): Promise<Operation> {
    const code = input.code?.trim() ?? '';
    const name = input.name?.trim() ?? '';
    if (!code)
      throw new InvalidOperationInputError('Operation code is required.');
    if (!name)
      throw new InvalidOperationInputError('Operation name is required.');
    if (await this.operations.findByCode(code))
      throw new DuplicateOperationCodeError(code);
    const operation = await this.operations.create({
      code,
      name,
      category: input.category?.trim() ?? '',
      requiredQualificationId: input.requiredQualificationId?.trim() ?? '',
      isActive: true,
      // A concurrent definer of the same code must fail, not overwrite.
      _insertOnly: true,
    });
    try {
      await operation.save();
    } catch (error) {
      if (await this.operations.findByCode(code))
        throw new DuplicateOperationCodeError(code);
      throw error;
    }
    return operation;
  }

  /** Fetch an operation or throw {@link OperationNotFoundError}. */
  async get(id: string): Promise<Operation> {
    const operation = id ? await this.operations.get(id) : null;
    if (!operation) throw new OperationNotFoundError(id);
    return operation;
  }

  /** List operations; retired ones only with `includeRetired`. */
  async list(options: { includeRetired?: boolean } = {}): Promise<Operation[]> {
    return this.operations.listOperations(options);
  }

  /** Change the display name. The code does not change. */
  async rename(id: string, name: string): Promise<Operation> {
    const next = name?.trim() ?? '';
    if (!next)
      throw new InvalidOperationInputError('Operation name is required.');
    const operation = await this.get(id);
    operation.name = next;
    await operation.save();
    return operation;
  }

  /** Change category and/or required qualification; an empty string clears. */
  async update(
    id: string,
    changes: { category?: string; requiredQualificationId?: string },
  ): Promise<Operation> {
    const operation = await this.get(id);
    if (changes.category !== undefined)
      operation.category = changes.category.trim();
    if (changes.requiredQualificationId !== undefined)
      operation.requiredQualificationId =
        changes.requiredQualificationId.trim();
    await operation.save();
    return operation;
  }

  /** Retire: stays on history and routings, leaves pickers. Idempotent. */
  async retire(id: string): Promise<Operation> {
    return this.setActive(id, false);
  }

  /** Reinstate a retired operation. Idempotent. */
  async reinstate(id: string): Promise<Operation> {
    return this.setActive(id, true);
  }

  private async setActive(id: string, isActive: boolean): Promise<Operation> {
    const operation = await this.get(id);
    if (operation.isActive !== isActive) {
      operation.isActive = isActive;
      await operation.save();
    }
    return operation;
  }
}

/** Convenience factory. */
export async function createOperationService(
  options: OperationServiceOptions,
): Promise<OperationService> {
  return OperationService.create(options);
}
