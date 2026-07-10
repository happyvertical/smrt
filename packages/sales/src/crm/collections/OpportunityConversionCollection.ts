/**
 * OpportunityConversionCollection — collection manager for
 * OpportunityConversion, including the idempotent recorder.
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { OpportunityConversion } from '../models/OpportunityConversion.js';
import type {
  RecordConversionParams,
  RecordConversionResult,
} from '../types.js';
import { OpportunityCollection } from './OpportunityCollection.js';

export class OpportunityConversionCollection extends SmrtCollection<OpportunityConversion> {
  static readonly _itemClass = OpportunityConversion;

  private opportunityCollectionPromise: Promise<OpportunityCollection> | null =
    null;

  /** Sibling opportunity collection sharing this collection's DB connection. */
  private async getOpportunityCollection(): Promise<OpportunityCollection> {
    if (!this.opportunityCollectionPromise) {
      this.opportunityCollectionPromise = OpportunityCollection.create({
        db: this.db,
      });
    }
    return this.opportunityCollectionPromise;
  }

  /** All conversion links recorded for one opportunity, oldest first. */
  async findByOpportunity(
    opportunityId: string,
  ): Promise<OpportunityConversion[]> {
    return await this.list({
      where: { opportunityId },
      orderBy: 'created_at ASC',
    });
  }

  /**
   * Record that a WON opportunity materialized into a downstream record,
   * idempotently on the natural key `(opportunityId, targetKind, targetId)`.
   *
   * Preconditions: the opportunity must exist and its status must be `'won'`
   * — conversions from open or lost deals are rejected with a clear error.
   * CRM only records the link; creating the downstream record itself
   * (client, project, contract, subscription, …) is the caller's job.
   *
   * @returns `{ conversion, created }` — `created: false` when the link
   *   already existed (the existing row is returned untouched)
   */
  async recordConversion(
    params: RecordConversionParams,
  ): Promise<RecordConversionResult> {
    const opportunities = await this.getOpportunityCollection();
    const opportunity = await opportunities.get({ id: params.opportunityId });
    if (!opportunity) {
      throw new Error(
        `OpportunityConversionCollection.recordConversion: opportunity '${params.opportunityId}' not found`,
      );
    }
    if (opportunity.status !== 'won') {
      throw new Error(
        `OpportunityConversionCollection.recordConversion: opportunity '${params.opportunityId}' ` +
          `has status '${opportunity.status}' — conversions can only be recorded for won opportunities`,
      );
    }

    const existing = await this.list({
      where: {
        opportunityId: params.opportunityId,
        targetKind: params.targetKind,
        targetId: params.targetId,
      },
      limit: 1,
    });
    if (existing[0]) {
      return { conversion: existing[0], created: false };
    }

    const conversion = await this.create({
      ...(opportunity.tenantId !== null
        ? { tenantId: opportunity.tenantId }
        : {}),
      opportunityId: params.opportunityId,
      targetKind: params.targetKind,
      targetId: params.targetId,
      note: params.note ?? '',
    });
    return { conversion, created: true };
  }
}

export default OpportunityConversionCollection;
