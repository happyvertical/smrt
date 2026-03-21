/**
 * FactSource model - Provenance tracking for facts
 *
 * Records where a fact came from, including source URL, type,
 * credibility, and extraction timestamp.
 */

import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { FactSourceOptions } from './types';

@TenantScoped({ mode: 'optional' })
@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get', 'create', 'delete'] },
  mcp: { include: ['list', 'get', 'create'] },
  cli: true,
})
export class FactSource extends SmrtObject {
  @field({ required: true })
  factId: string = '';

  @field()
  sourceType: string = '';
  @field()
  sourceUrl: string = '';
  @field()
  sourceTitle: string = '';
  @field()
  credibility: number = 0.0;
  @field()
  extractedAt: Date = new Date();
  @field()
  metadata: string = '';

  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @field()
  createdAt: Date = new Date();
  @field()
  updatedAt: Date = new Date();

  constructor(options: FactSourceOptions = {}) {
    super(options);
    if (options.factId) this.factId = options.factId;
    if (options.sourceType !== undefined) this.sourceType = options.sourceType;
    if (options.sourceUrl !== undefined) this.sourceUrl = options.sourceUrl;
    if (options.sourceTitle !== undefined)
      this.sourceTitle = options.sourceTitle;
    if (options.credibility !== undefined)
      this.credibility = options.credibility;
    if (options.extractedAt) this.extractedAt = options.extractedAt;

    if (options.metadata !== undefined) {
      if (typeof options.metadata === 'string') {
        this.metadata = options.metadata;
      } else {
        this.metadata = JSON.stringify(options.metadata);
      }
    }
  }

  getMetadata(): Record<string, any> {
    const raw = this.metadata;
    if (!raw) return {};
    if (typeof raw === 'object') return raw as unknown as Record<string, any>;
    try {
      return JSON.parse(String(raw));
    } catch {
      return {};
    }
  }

  setMetadata(data: Record<string, any>): void {
    this.metadata = JSON.stringify(data);
  }

  updateMetadata(updates: Record<string, any>): void {
    const current = this.getMetadata();
    this.metadata = JSON.stringify({ ...current, ...updates });
  }

  /**
   * Get the fact this source belongs to
   */
  async getFact(): Promise<import('./fact').Fact | null> {
    if (!this.factId) return null;

    const { FactCollection } = await import('./facts');
    const collection = await (FactCollection as any).create(this.options);
    return await collection.get({ id: this.factId });
  }
}
