/**
 * OperationCollection — query helpers for {@link Operation} rows.
 *
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Operation } from '../models/Operation.js';

export class OperationCollection extends SmrtCollection<Operation> {
  static readonly _itemClass = Operation;

  /** Return the operation with the given code, or `null`. */
  async findByCode(code: string): Promise<Operation | null> {
    const matches = await this.list({ where: { code }, limit: 1 });
    return matches[0] ?? null;
  }

  /**
   * Return operations ordered by category then code. Retired operations are
   * left out unless `includeRetired` is set, so the default is a picker list.
   */
  async listOperations(
    options: { includeRetired?: boolean } = {},
  ): Promise<Operation[]> {
    return this.list({
      where: options.includeRetired ? {} : { isActive: true },
      orderBy: ['category ASC', 'code ASC'],
    });
  }
}
