/**
 * FactEvidenceCollection - Collection manager for concrete fact evidence.
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { FactEvidence } from './fact-evidence';
import type { FactEvidenceOptions } from './types';

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
      metadata: serializeEvidenceMetadata(options.metadata),
      evidenceKey,
    });
  }
}
