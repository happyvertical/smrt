/**
 * FactTag model - Join table between facts and tags
 *
 * Links facts to tags via tag slug (not tag ID),
 * enabling categorization and discovery of facts.
 */

import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { FactTagOptions } from './types';

@TenantScoped({ mode: 'optional' })
@smrt({
  conflictColumns: ['fact_id', 'tag_slug'],
  api: { include: ['list', 'get', 'create', 'delete'] },
  mcp: { include: ['list', 'get', 'create'] },
  cli: true,
})
export class FactTag extends SmrtObject {
  @field({ required: true })
  factId: string = '';

  @field({ required: true })
  tagSlug: string = '';

  metadata: string = '';

  @tenantId({ nullable: true })
  tenantId: string | null = null;

  createdAt: Date = new Date();
  updatedAt: Date = new Date();

  constructor(options: FactTagOptions = {}) {
    super(options);
    if (options.factId) this.factId = options.factId;
    if (options.tagSlug) this.tagSlug = options.tagSlug;

    if (options.metadata !== undefined) {
      if (typeof options.metadata === 'string') {
        this.metadata = options.metadata;
      } else {
        this.metadata = JSON.stringify(options.metadata);
      }
    }
  }

  /**
   * Get metadata as parsed object
   */
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

  /**
   * Set metadata from object
   */
  setMetadata(data: Record<string, any>): void {
    this.metadata = JSON.stringify(data);
  }

  /**
   * Update metadata by merging with existing values
   */
  updateMetadata(updates: Record<string, any>): void {
    const current = this.getMetadata();
    this.metadata = JSON.stringify({ ...current, ...updates });
  }

  /**
   * Get the fact this tag link belongs to
   */
  async getFact(): Promise<import('./fact').Fact | null> {
    if (!this.factId) return null;

    const { FactCollection } = await import('./facts');
    const collection = await (FactCollection as any).create(this.options);
    return await collection.get({ id: this.factId });
  }
}
