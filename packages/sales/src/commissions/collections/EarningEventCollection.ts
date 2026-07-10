/**
 * EarningEventCollection — collection manager for {@link EarningEvent}.
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { EarningEvent } from '../models/EarningEvent.js';
import type { EarningEventOptions } from '../types.js';

export class EarningEventCollection extends SmrtCollection<EarningEvent> {
  static readonly _itemClass = EarningEvent;

  /** Look up an event by its idempotency natural key. */
  async findByDedupeKey(dedupeKey: string): Promise<EarningEvent | null> {
    if (!dedupeKey) return null;
    const results = await this.list({ where: { dedupeKey }, limit: 1 });
    return results[0] ?? null;
  }

  /**
   * Idempotent ingestion: if an event with `options.dedupeKey` already
   * exists, return it untouched (`created: false`) — evidence is immutable,
   * so a replay never updates the stored row. Otherwise create the event.
   *
   * `dedupeKey` is required — callers embed tenant/source identity in it
   * (e.g. `` `${tenantId}:${sourceKind}:${sourceId}:${eventKind}` ``);
   * an empty key would silently disable idempotency, so it throws instead.
   */
  async getOrCreateByDedupeKey(
    options: EarningEventOptions,
  ): Promise<{ event: EarningEvent; created: boolean }> {
    const dedupeKey = options.dedupeKey ?? '';
    if (!dedupeKey) {
      throw new Error(
        'EarningEventCollection.getOrCreateByDedupeKey requires a dedupeKey',
      );
    }
    const existing = await this.findByDedupeKey(dedupeKey);
    if (existing) {
      return { event: existing, created: false };
    }
    // Coerce the Date-ish option here so the create input is a real Date
    // (the model would coerce at initialize anyway; this keeps types exact).
    const { occurredAt, ...rest } = options;
    const event = await this.create({
      ...rest,
      ...(occurredAt !== undefined ? { occurredAt: new Date(occurredAt) } : {}),
    });
    return { event, created: true };
  }

  /** Events for one generic earning source, newest occurrence first. */
  async findBySource(
    sourceKind: string,
    sourceId: string,
  ): Promise<EarningEvent[]> {
    return await this.list({
      where: { sourceKind, sourceId },
      orderBy: 'occurred_at DESC',
    });
  }

  /** Events by kind, newest occurrence first. */
  async findByKind(eventKind: string): Promise<EarningEvent[]> {
    return await this.list({
      where: { eventKind },
      orderBy: 'occurred_at DESC',
    });
  }
}

export default EarningEventCollection;
