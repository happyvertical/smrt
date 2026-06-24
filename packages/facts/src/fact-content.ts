/**
 * FactContent model - Join table between facts and content
 *
 * Links facts to content objects (from @happyvertical/smrt-content)
 * with relationship classification and metadata.
 */

import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { FactContentOptions, FactContentRelationship } from './types';

@TenantScoped({ mode: 'optional' })
@smrt({
  conflictColumns: ['fact_id', 'content_id', 'relationship'],
  api: { include: ['list', 'get', 'create', 'delete'] },
  mcp: { include: ['list', 'get', 'create'] },
  cli: true,
})
export class FactContent extends SmrtObject {
  @foreignKey('Fact', { required: true })
  factId: string = '';

  @crossPackageRef('@happyvertical/smrt-content:Content', { required: true })
  contentId: string = '';

  @field({ required: true })
  relationship: string = 'extracted_from';

  @field()
  metadata: string = '';

  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @field()
  createdAt: Date = new Date();
  @field()
  updatedAt: Date = new Date();

  constructor(options: FactContentOptions = {}) {
    super(options);
    if (options.factId) this.factId = options.factId;
    if (options.contentId) this.contentId = options.contentId;
    if (options.relationship !== undefined)
      this.relationship = options.relationship;

    if (options.metadata !== undefined) {
      if (typeof options.metadata === 'string') {
        this.metadata = options.metadata;
      } else {
        this.metadata = JSON.stringify(options.metadata);
      }
    }
  }

  /**
   * Get the relationship type as a typed value
   */
  getRelationship(): FactContentRelationship {
    return this.relationship as FactContentRelationship;
  }

  /**
   * Get metadata as parsed object
   */
  getMetadata(): Record<string, unknown> {
    const raw = this.metadata;
    if (!raw) return {};
    if (typeof raw === 'object') return raw as unknown as Record<string, unknown>;
    try {
      return JSON.parse(String(raw));
    } catch {
      return {};
    }
  }

  /**
   * Set metadata from object
   */
  setMetadata(data: Record<string, unknown>): void {
    this.metadata = JSON.stringify(data);
  }

  /**
   * Update metadata by merging with existing values
   */
  updateMetadata(updates: Record<string, unknown>): void {
    const current = this.getMetadata();
    this.metadata = JSON.stringify({ ...current, ...updates });
  }

  /**
   * Get the fact this content link belongs to
   */
  async getFact(): Promise<import('./fact').Fact | null> {
    if (!this.factId) return null;

    const { FactCollection } = await import('./facts');
    const collection = await FactCollection.create(this.options);
    return await collection.get({ id: this.factId });
  }
}
