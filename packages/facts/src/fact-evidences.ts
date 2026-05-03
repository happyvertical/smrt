/**
 * FactEvidenceCollection - Collection manager for concrete fact evidence.
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { FactEvidence } from './fact-evidence';
import type { FactEvidenceOptions, FactEvidenceStatus } from './types';

const FACT_EVIDENCE_STATUSES: FactEvidenceStatus[] = [
  'supports',
  'contradicts',
  'unclear',
  'irrelevant',
  'invalid',
];

function normalizeFactEvidenceStatus(value: unknown): FactEvidenceStatus {
  return FACT_EVIDENCE_STATUSES.includes(value as FactEvidenceStatus)
    ? (value as FactEvidenceStatus)
    : 'supports';
}

function normalizeEvidenceKeyPart(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ');
}

function hashEvidenceKey(input: string): string {
  let hash = 5381;

  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 33) ^ input.charCodeAt(index);
  }

  return `ev-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function serializeEvidenceMetadata(
  value: FactEvidenceOptions['metadata'],
): string | undefined {
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function createFactEvidenceKey(
  input: Pick<
    FactEvidenceOptions,
    'sourceKind' | 'sourceId' | 'sourceUrl' | 'locator' | 'quote'
  >,
): string {
  return hashEvidenceKey(
    [
      normalizeEvidenceKeyPart(input.sourceKind),
      normalizeEvidenceKeyPart(input.sourceId),
      normalizeEvidenceKeyPart(input.sourceUrl),
      normalizeEvidenceKeyPart(input.locator),
      normalizeEvidenceKeyPart(input.quote),
    ].join('|'),
  );
}

export class FactEvidenceCollection extends SmrtCollection<FactEvidence> {
  static readonly _itemClass = FactEvidence;

  async getForFact(factId: string): Promise<FactEvidence[]> {
    return this.list({ where: { factId }, orderBy: 'created_at ASC' });
  }

  async getForSource(
    sourceKind: string,
    sourceId: string,
  ): Promise<FactEvidence[]> {
    return this.list({
      where: { sourceKind, sourceId },
      orderBy: 'created_at ASC',
    });
  }

  async getForSources(
    sources: Array<{ sourceKind: string; sourceId: string }>,
  ): Promise<FactEvidence[]> {
    const byId = new Map<string, FactEvidence>();

    for (const source of sources) {
      const entries = await this.getForSource(
        source.sourceKind,
        source.sourceId,
      );
      for (const entry of entries) {
        const key =
          typeof entry.id === 'string' && entry.id
            ? entry.id
            : `${entry.factId}:${entry.evidenceKey}`;
        byId.set(key, entry);
      }
    }

    return [...byId.values()];
  }

  async bulkUpdateStatus(
    evidenceIds: string[],
    status: FactEvidenceStatus,
    options: { reason?: string; reviewedBy?: string | null } = {},
  ): Promise<FactEvidence[]> {
    const uniqueIds = [...new Set(evidenceIds.filter(Boolean))];
    const normalizedStatus = normalizeFactEvidenceStatus(status);
    const updated: FactEvidence[] = [];

    for (const evidenceId of uniqueIds) {
      const entry = await this.get({ id: evidenceId });
      if (!entry) {
        continue;
      }

      entry.status = normalizedStatus;
      entry.updateMetadata({
        evidenceStatusReason: options.reason || null,
        evidenceStatusReviewedBy: options.reviewedBy || null,
        evidenceStatusUpdatedAt: new Date().toISOString(),
      });
      await entry.save();
      updated.push(entry);
    }

    return updated;
  }

  async replaceGeneratedForSources(
    sources: Array<{ sourceKind: string; sourceId: string }>,
    options: {
      generatedBy?: string;
      contentId?: string;
      tenantId?: string | null;
    } = {},
  ): Promise<{ deletedEvidenceIds: string[] }> {
    const deletedEvidenceIds: string[] = [];
    const sourceEntries = [
      ...new Map(
        sources.map((source) => [
          `${source.sourceKind}:${source.sourceId}`,
          source,
        ]),
      ).values(),
    ];

    if (sourceEntries.length === 0) {
      return { deletedEvidenceIds };
    }

    const entriesById = new Map<string, FactEvidence>();
    const useTenantFilter = Object.hasOwn(options, 'tenantId');
    for (const source of sourceEntries) {
      const entries = await this.list({
        where: {
          sourceKind: source.sourceKind,
          sourceId: source.sourceId,
          ...(useTenantFilter ? { tenantId: options.tenantId ?? null } : {}),
        },
      });
      for (const entry of entries) {
        const key =
          typeof entry.id === 'string' && entry.id
            ? entry.id
            : `${entry.factId}:${entry.evidenceKey}`;
        entriesById.set(key, entry);
      }
    }

    const entries = [...entriesById.values()];
    for (const entry of entries) {
      if (
        useTenantFilter &&
        (entry.tenantId ?? null) !== (options.tenantId ?? null)
      ) {
        continue;
      }

      const metadata = entry.getMetadata();
      if (options.generatedBy && metadata.generatedBy !== options.generatedBy) {
        continue;
      }
      if (options.contentId && metadata.contentId !== options.contentId) {
        continue;
      }

      if (typeof entry.id === 'string') {
        deletedEvidenceIds.push(entry.id);
      }
      await entry.delete();
    }

    return { deletedEvidenceIds };
  }

  async upsertEvidence(options: FactEvidenceOptions): Promise<FactEvidence> {
    if (!options.factId) {
      throw new Error('factId is required for evidence');
    }

    const evidenceKey = options.evidenceKey || createFactEvidenceKey(options);
    const existing = (await this.get({
      factId: options.factId,
      evidenceKey,
    })) as FactEvidence | null;

    if (existing) {
      Object.assign(existing, {
        status: normalizeFactEvidenceStatus(options.status ?? existing.status),
        sourceKind: options.sourceKind ?? existing.sourceKind,
        sourceId: options.sourceId ?? existing.sourceId,
        sourceUrl: options.sourceUrl ?? existing.sourceUrl,
        sourceTitle: options.sourceTitle ?? existing.sourceTitle,
        quote: options.quote ?? existing.quote,
        locator: options.locator ?? existing.locator,
        extractionMethod: options.extractionMethod ?? existing.extractionMethod,
        confidence: options.confidence ?? existing.confidence,
        tenantId: options.tenantId ?? existing.tenantId,
      });

      if (options.metadata !== undefined) {
        existing.metadata =
          typeof options.metadata === 'string'
            ? options.metadata
            : JSON.stringify(options.metadata);
      }

      await existing.save();
      return existing;
    }

    return this.create({
      ...options,
      status: normalizeFactEvidenceStatus(options.status),
      metadata: serializeEvidenceMetadata(options.metadata),
      evidenceKey,
    });
  }
}
