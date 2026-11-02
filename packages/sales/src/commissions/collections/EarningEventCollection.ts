/**
 * EarningEventCollection — collection manager for {@link EarningEvent}.
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { EarningEvent } from '../models/EarningEvent.js';
import { findByReplayKey, resolveReplayOwner } from '../replay-owner.js';
import type { EarningEventOptions } from '../types.js';

export class EarningEventCollection extends SmrtCollection<EarningEvent> {
  static readonly _itemClass = EarningEvent;

  /**
   * Look up an event by its idempotency natural key within one owner
   * (#3305 D1): `options.tenantId`, else the active context; neither →
   * global events only. Never returns another tenant's event.
   */
  async findByDedupeKey(
    dedupeKey: string,
    options: { tenantId?: string | null } = {},
  ): Promise<EarningEvent | null> {
    if (!dedupeKey) return null;
    const owner = resolveReplayOwner(
      options.tenantId,
      'EarningEventCollection.findByDedupeKey',
    );
    return findByReplayKey(this, 'dedupe_key', dedupeKey, owner);
  }

  /**
   * Idempotent ingestion: if an event with `options.dedupeKey` already
   * exists, return it untouched (`created: false`) — evidence is immutable,
   * so a replay never updates the stored row. Otherwise create the event.
   *
   * `dedupeKey` is required and unique per tenant (#3305 D1); an empty key
   * would silently disable idempotency, so it throws instead. The replay
   * lookup and the create share one owner (`options.tenantId`, else the
   * context), so a retry finds what it filed and never another tenant's.
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
    const tenantId = resolveReplayOwner(
      options.tenantId,
      'EarningEventCollection.getOrCreateByDedupeKey',
    );
    const existing = await this.findByDedupeKey(dedupeKey, { tenantId });
    if (existing) {
      return { event: existing, created: false };
    }
    // Coerce the Date-ish option here so the create input is a real Date
    // (the model would coerce at initialize anyway; this keeps types exact).
    const { occurredAt, ...rest } = options;
    const event = await this.create({
      ...rest,
      tenantId,
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
