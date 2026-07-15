import { SmrtCollection } from '@happyvertical/smrt-core';
import { AgreementExecutionEvent } from '../models/AgreementExecutionEvent.js';
import type { VerifiedAgreementExecutionEventOptions } from '../types.js';
import { coerceAgreementDate } from '../types.js';

export class AgreementExecutionEventCollection extends SmrtCollection<AgreementExecutionEvent> {
  static readonly _itemClass = AgreementExecutionEvent;

  async findByDedupeKey(
    dedupeKey: string,
  ): Promise<AgreementExecutionEvent | null> {
    const rows = await this.list({ where: { dedupeKey }, limit: 1 });
    return rows[0] ?? null;
  }

  async recordVerified(
    options: VerifiedAgreementExecutionEventOptions,
  ): Promise<{ event: AgreementExecutionEvent; created: boolean }> {
    if (!options.dedupeKey) {
      throw new Error('AgreementExecutionEvent requires a dedupe key');
    }
    const occurredAt = coerceAgreementDate(options.occurredAt);
    if (!occurredAt) {
      throw new Error('AgreementExecutionEvent requires a valid occurredAt');
    }
    const receivedAt = coerceAgreementDate(options.receivedAt);
    if (!receivedAt) {
      throw new Error('AgreementExecutionEvent requires a valid receivedAt');
    }
    const existing = await this.findByDedupeKey(options.dedupeKey);
    if (existing) {
      this.assertSameVerifiedEvent(existing, options, occurredAt, receivedAt);
      return { event: existing, created: false };
    }
    const {
      occurredAt: _occurredAt,
      receivedAt: _receivedAt,
      ...rest
    } = options;
    try {
      return {
        event: await this.create({
          ...rest,
          occurredAt,
          receivedAt,
          _insertOnly: true,
        }),
        created: true,
      };
    } catch (error) {
      const raced = await this.findByDedupeKey(options.dedupeKey);
      if (!raced) throw error;
      this.assertSameVerifiedEvent(raced, options, occurredAt, receivedAt);
      return { event: raced, created: false };
    }
  }

  private assertSameVerifiedEvent(
    existing: AgreementExecutionEvent,
    options: VerifiedAgreementExecutionEventOptions,
    occurredAt: Date,
    receivedAt: Date,
  ): void {
    if (
      existing.executionId !== options.executionId ||
      existing.provider !== options.provider ||
      existing.providerEventId !== (options.providerEventId ?? '') ||
      existing.eventOrigin !== (options.eventOrigin ?? 'provider_webhook') ||
      existing.operationId !== (options.operationId ?? '') ||
      existing.orderingKey !== (options.orderingKey ?? '') ||
      existing.eventType !== (options.eventType ?? '') ||
      existing.status !== options.status ||
      existing.occurredAt.toISOString() !== occurredAt.toISOString() ||
      existing.receivedAt.toISOString() !== receivedAt.toISOString() ||
      existing.payloadSha256 !== (options.payloadSha256 ?? '') ||
      existing.signerEvidence !== (options.signerEvidence ?? '[]') ||
      existing.payload !== (options.payload ?? '{}')
    ) {
      throw new Error(
        `AgreementExecutionEvent dedupe key '${options.dedupeKey}' collides with different verified evidence`,
      );
    }
  }

  async findByExecution(
    executionId: string,
  ): Promise<AgreementExecutionEvent[]> {
    return await this.list({
      where: { executionId },
      orderBy: 'occurred_at ASC',
    });
  }

  async findProviderEventsByExecution(
    executionId: string,
  ): Promise<AgreementExecutionEvent[]> {
    return await this.list({
      where: { executionId, eventOrigin: 'provider_webhook' },
      orderBy: 'occurred_at ASC',
    });
  }
}

export default AgreementExecutionEventCollection;
