/**
 * FactSubject model - Polymorphic entity linking for facts
 *
 * Links facts to any entity type (profiles, places, events, etc.)
 * using polymorphic entityType + entityId with role classification.
 */

import { field, foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { FactSubjectOptions, SubjectRole } from './types';

@TenantScoped({ mode: 'optional' })
@smrt({
  conflictColumns: ['fact_id', 'entity_type', 'entity_id'],
  api: { include: ['list', 'get', 'create', 'delete'] },
  mcp: { include: ['list', 'get', 'create'] },
  cli: true,
})
export class FactSubject extends SmrtObject {
  @foreignKey('Fact', { required: true })
  factId: string = '';

  @field({ required: true })
  entityType: string = '';

  @field({ required: true })
  entityId: string = '';

  @field()
  role: string = 'subject';
  @field()
  metadata: string = '';

  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @field()
  createdAt: Date = new Date();
  @field()
  updatedAt: Date = new Date();

  constructor(options: FactSubjectOptions = {}) {
    super(options);
    if (options.factId) this.factId = options.factId;
    if (options.entityType) this.entityType = options.entityType;
    if (options.entityId) this.entityId = options.entityId;
    if (options.role !== undefined) this.role = options.role;

    if (options.metadata !== undefined) {
      if (typeof options.metadata === 'string') {
        this.metadata = options.metadata;
      } else {
        this.metadata = JSON.stringify(options.metadata);
      }
    }
  }

  getRole(): SubjectRole {
    return this.role as SubjectRole;
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
   * Get the fact this subject is linked to
   */
  async getFact(): Promise<import('./fact').Fact | null> {
    if (!this.factId) return null;

    const { FactCollection } = await import('./facts');
    const collection = await (FactCollection as any).create(this.options);
    return await collection.get({ id: this.factId });
  }
}
