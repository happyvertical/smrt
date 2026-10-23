/** Policy-free, caller-transaction Lead conversion receipts. @packageDocumentation */
import { createHash } from 'node:crypto';
import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { requireTenantId } from '@happyvertical/smrt-tenancy';
import { LeadCollection } from '../collections/LeadCollection.js';
import { SalesActivityCollection } from '../collections/SalesActivityCollection.js';

/** Scope of one downstream conversion. Target kinds are host-defined. */
export interface GetLeadConversionInput {
  tenantId: string;
  leadId: string;
  targetKind: string;
}
/** Immutable host-created downstream target and its provenance. */
export interface LeadConversionReceipt extends GetLeadConversionInput {
  id: string;
  targetId: string;
  actorProfileId: string;
  metadata: Record<string, unknown>;
}
/** Record a target the host created within the same transaction. */
export interface RecordLeadConversionInput extends GetLeadConversionInput {
  targetId: string;
  actorProfileId: string;
  metadata?: Record<string, unknown>;
}

/**
 * Records an early Lead conversion without qualifying or closing a deal.
 * The host must authorize inputs, own the transaction, and serialize writes
 * for the tenant/lead/targetKind scope before creating a target. This service
 * participates in that executor and never opens a nested transaction. Returned
 * receipts are plain data; use them only after the caller commits.
 */
export class LeadConversionService {
  private constructor(
    private readonly leads: LeadCollection,
    private readonly activities: SalesActivityCollection,
    private readonly callerTransaction: boolean,
  ) {}

  /** Bind read access to any initialized executor; mutations require caller mode. */
  static async create(
    options: SmrtClassOptions & { transaction?: 'caller' },
  ): Promise<LeadConversionService> {
    if (!options.db)
      throw new Error('Lead conversion requires an initialized database');
    const collectionOptions = {
      db: options.db,
      _reuseInitializedDb: true,
      _deferRuntimeInitialization: true,
    };
    return new LeadConversionService(
      await LeadCollection.create(collectionOptions),
      await SalesActivityCollection.create(collectionOptions),
      options.transaction === 'caller',
    );
  }

  /** Read the tenant-local receipt, failing closed for inaccessible Leads. */
  async getForLead(
    input: GetLeadConversionInput,
  ): Promise<LeadConversionReceipt | null> {
    const scope = await this.scope(input);
    const id = receiptId(scope);
    const activity = await this.activities.get({ id }, { cache: false });
    if (!activity) return null;
    const envelope = activity.getMetadata();
    if (
      activity.tenantId !== scope.tenantId ||
      activity.subjectKind !== 'lead' ||
      activity.subjectId !== scope.leadId ||
      activity.activityKind !== 'lead_conversion' ||
      envelope.targetKind !== scope.targetKind ||
      typeof envelope.targetId !== 'string' ||
      !envelope.targetId ||
      !isObject(envelope.metadata)
    ) {
      throw new Error('Lead conversion receipt is inconsistent');
    }
    return {
      ...scope,
      id,
      targetId: envelope.targetId,
      actorProfileId: activity.actorProfileId,
      metadata: envelope.metadata,
    };
  }

  /** Resolve originating Leads for a host target without exposing receipt storage. */
  async findForTarget(input: {
    tenantId: string;
    targetKind: string;
    targetId: string;
  }): Promise<LeadConversionReceipt[]> {
    const tenantId = requireTenantId();
    if (input.tenantId !== tenantId)
      throw new Error('Lead is unavailable in the active tenant');
    const targetKind = text(input.targetKind, 'targetKind');
    const targetId = text(input.targetId, 'targetId');
    const candidates = await this.activities.list({
      where: { tenantId, subjectKind: 'lead', activityKind: 'lead_conversion' },
      orderBy: 'created_at ASC',
    });
    const receipts: LeadConversionReceipt[] = [];
    for (const candidate of candidates) {
      const metadata = candidate.getMetadata();
      if (metadata.targetKind !== targetKind || metadata.targetId !== targetId)
        continue;
      const receipt = await this.getForLead({
        tenantId,
        leadId: candidate.subjectId,
        targetKind,
      });
      if (
        receipt &&
        receipt.id === candidate.id &&
        receipt.targetId === targetId
      )
        receipts.push(receipt);
    }
    return receipts;
  }

  /** Exact retries preserve the original actor and receipt; changed intent fails. */
  async recordForLead(
    input: RecordLeadConversionInput,
  ): Promise<LeadConversionReceipt> {
    if (!this.callerTransaction)
      throw new Error('Lead conversion requires a caller-owned transaction');
    const targetId = text(input.targetId, 'targetId');
    const actorProfileId = text(input.actorProfileId, 'actorProfileId');
    const metadata = jsonObject(input.metadata ?? {});
    const existing = await this.getForLead(input);
    if (existing) {
      if (
        existing.targetId !== targetId ||
        stableJson(existing.metadata) !== stableJson(metadata)
      ) {
        throw new Error(
          'Lead conversion already recorded with different intent',
        );
      }
      return existing;
    }
    const scope = await this.scope(input);
    const id = receiptId(scope);
    await this.activities.create({
      id,
      tenantId: scope.tenantId,
      subjectKind: 'lead',
      subjectId: scope.leadId,
      activityKind: 'lead_conversion',
      summary: `Lead converted to ${scope.targetKind}`,
      actorProfileId,
      metadata: JSON.stringify({
        targetKind: scope.targetKind,
        targetId,
        metadata,
      }),
    });
    return { ...scope, id, targetId, actorProfileId, metadata };
  }

  private async scope(
    input: GetLeadConversionInput,
  ): Promise<GetLeadConversionInput> {
    const tenantId = requireTenantId();
    if (input.tenantId !== tenantId)
      throw new Error('Lead is unavailable in the active tenant');
    const leadId = text(input.leadId, 'leadId');
    const targetKind = text(input.targetKind, 'targetKind');
    const lead = await this.leads.get({ id: leadId }, { cache: false });
    if (!lead || lead.tenantId !== tenantId)
      throw new Error('Lead is unavailable in the active tenant');
    return { tenantId, leadId, targetKind };
  }
}

function text(value: string, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    throw new Error(
      `Lead conversion ${name} must be a nonempty trimmed string`,
    );
  }
  return value;
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function jsonObject(value: unknown): Record<string, unknown> {
  if (!isObject(value))
    throw new Error('Lead conversion metadata must be a JSON object');
  let encoded: string;
  try {
    encoded = JSON.stringify(value, (_key, item) => {
      if (
        typeof item === 'function' ||
        typeof item === 'symbol' ||
        typeof item === 'undefined' ||
        (typeof item === 'number' && !Number.isFinite(item))
      ) {
        throw new Error('Non-JSON metadata');
      }
      return item;
    });
  } catch {
    throw new Error('Lead conversion metadata must contain only JSON data');
  }
  return JSON.parse(encoded) as Record<string, unknown>;
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isObject(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
function receiptId(scope: GetLeadConversionInput): string {
  const hash = createHash('sha256')
    .update(
      JSON.stringify([
        'lead-conversion-v1',
        scope.tenantId,
        scope.leadId,
        scope.targetKind,
      ]),
    )
    .digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
