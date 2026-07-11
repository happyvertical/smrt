/**
 * AttributionExceptionCollection — collection manager for
 * {@link AttributionException}.
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { AttributionException } from '../models/AttributionException.js';

export class AttributionExceptionCollection extends SmrtCollection<AttributionException> {
  static readonly _itemClass = AttributionException;

  /** Every open exception, oldest first (the review queue). */
  async findOpen(): Promise<AttributionException[]> {
    return await this.list({
      where: { status: 'open' },
      orderBy: 'created_at ASC',
    });
  }

  /**
   * The open exception for one target within one program, or `null`.
   * `AttributionService.resolve()` returns this instead of minting a
   * duplicate when a conflict is already parked for review.
   */
  async findOpenByTarget(
    targetKind: string,
    targetId: string,
    programId: string,
  ): Promise<AttributionException | null> {
    const results = await this.list({
      where: { targetKind, targetId, programId, status: 'open' },
      orderBy: 'created_at ASC',
      limit: 1,
    });
    return results[0] ?? null;
  }

  /** Every exception (open and resolved) for one target, newest first. */
  async findByTarget(
    targetKind: string,
    targetId: string,
  ): Promise<AttributionException[]> {
    return await this.list({
      where: { targetKind, targetId },
      orderBy: 'created_at DESC',
    });
  }
}

export default AttributionExceptionCollection;
