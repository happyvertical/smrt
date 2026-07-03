/**
 * FactEvidence model - specific provenance spans for facts
 *
 * FactSource remains the coarse source summary. FactEvidence records the
 * concrete excerpt/span/artifact that supports a fact.
 */

import { field, foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { FactEvidenceOptions, FactEvidenceStatus } from './types';

const FACT_EVIDENCE_STATUSES: FactEvidenceStatus[] = [
  'supports',
  'contradicts',
  'unclear',
  'irrelevant',
  'invalid',
];

function normalizeFactEvidenceStatus(
  value: FactEvidenceStatus | undefined,
): FactEvidenceStatus {
  return FACT_EVIDENCE_STATUSES.includes(value as FactEvidenceStatus)
    ? (value as FactEvidenceStatus)
    : 'supports';
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'fact_evidences',
  conflictColumns: ['fact_id', 'evidence_key'],
  api: { include: ['list', 'get', 'create', 'delete'] },
  mcp: { include: ['list', 'get', 'create'] },
  cli: true,
})
export class FactEvidence extends SmrtObject {
  @foreignKey('Fact', { required: true })
  factId: string = '';

  @field({ required: true })
  evidenceKey: string = '';

  @field({ type: 'text', required: true, default: 'supports' })
  status: FactEvidenceStatus = 'supports';

  @field()
  sourceKind: string = '';

  @field()
  sourceId: string = '';

  @field()
  sourceUrl: string = '';

  @field()
  sourceTitle: string = '';

  @field()
  quote: string = '';

  @field()
  locator: string = '';

  @field()
  extractionMethod: string = '';

  @field()
  confidence: number = 0;

  @field()
  metadata: string = '';

  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @field()
  createdAt: Date = new Date();

  @field()
  updatedAt: Date = new Date();

  constructor(options: FactEvidenceOptions = {}) {
    super(options);
    if (options.factId) this.factId = options.factId;
    if (options.evidenceKey) this.evidenceKey = options.evidenceKey;
    this.status = normalizeFactEvidenceStatus(options.status);
    if (options.sourceKind !== undefined) this.sourceKind = options.sourceKind;
    if (options.sourceId !== undefined) this.sourceId = options.sourceId;
    if (options.sourceUrl !== undefined) this.sourceUrl = options.sourceUrl;
    if (options.sourceTitle !== undefined)
      this.sourceTitle = options.sourceTitle;
    if (options.quote !== undefined) this.quote = options.quote;
    if (options.locator !== undefined) this.locator = options.locator;
    if (options.extractionMethod !== undefined)
      this.extractionMethod = options.extractionMethod;
    if (options.confidence !== undefined) this.confidence = options.confidence;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.createdAt) this.createdAt = options.createdAt;
    if (options.updatedAt) this.updatedAt = options.updatedAt;

    if (options.metadata !== undefined) {
      this.metadata =
        typeof options.metadata === 'string'
          ? options.metadata
          : JSON.stringify(options.metadata);
    }
  }

  getMetadata(): Record<string, unknown> {
    const raw = this.metadata;
    if (!raw) return {};
    if (typeof raw === 'object')
      return raw as unknown as Record<string, unknown>;
    try {
      return JSON.parse(String(raw));
    } catch {
      return {};
    }
  }

  setMetadata(data: Record<string, unknown>): void {
    this.metadata = JSON.stringify(data);
  }

  updateMetadata(updates: Record<string, unknown>): void {
    const current = this.getMetadata();
    this.metadata = JSON.stringify({ ...current, ...updates });
  }
}
