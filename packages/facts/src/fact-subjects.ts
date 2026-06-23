/**
 * FactSubjectCollection - Collection manager for FactSubject objects
 *
 * Provides queries for polymorphic entity linking, including
 * link/unlink operations and entity-centric lookups.
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { queryGlobal, queryWithGlobals } from '@happyvertical/smrt-tenancy';
import { FactSubject } from './fact-subject';
import type { SubjectRole } from './types';

export class FactSubjectCollection extends SmrtCollection<FactSubject> {
  static readonly _itemClass = FactSubject;

  /**
   * Get all subjects linked to a fact
   */
  async getForFact(factId: string): Promise<FactSubject[]> {
    return this.list({ where: { factId } });
  }

  /**
   * Get all fact-subject links for a given entity
   */
  async getForEntity(
    entityType: string,
    entityId: string,
  ): Promise<FactSubject[]> {
    return this.list({ where: { entityType, entityId } });
  }

  /**
   * Link an entity to a fact
   */
  async linkEntity(
    factId: string,
    entityType: string,
    entityId: string,
    role: SubjectRole = 'subject',
  ): Promise<FactSubject> {
    return this.create({
      factId,
      entityType,
      entityId,
      role,
    });
  }

  /**
   * Unlink an entity from a fact
   */
  async unlinkEntity(
    factId: string,
    entityType: string,
    entityId: string,
  ): Promise<void> {
    const links = await this.list({
      where: { factId, entityType, entityId },
    });
    for (const link of links) {
      await link.delete();
    }
  }

  /**
   * Get subjects by role for a fact
   */
  async getByRole(factId: string, role: SubjectRole): Promise<FactSubject[]> {
    return this.list({ where: { factId, role } });
  }

  /**
   * Count entities linked to a fact
   */
  async countForFact(factId: string): Promise<number> {
    const subjects = await this.getForFact(factId);
    return subjects.length;
  }

  // =========================================================================
  // Tenant Helper Methods
  // =========================================================================

  /**
   * Find all subjects belonging to a specific tenant
   */
  async findByTenant(tenantId: string): Promise<FactSubject[]> {
    return this.list({ where: { tenantId } });
  }

  /**
   * Find all global (tenant-less) subjects.
   *
   * Routes through the shared tenant-global helper so it does not throw under
   * an active tenant context (an explicit `tenant_id IS NULL` filter would be
   * flagged as an isolation violation). (#1600)
   */
  async findGlobal(): Promise<FactSubject[]> {
    return queryGlobal<FactSubject>(this);
  }

  /**
   * Find subjects for a tenant including global subjects.
   *
   * Fails closed if an active tenant context requests a different tenant's
   * rows; the admin/system path keeps the cross-tenant capability. (#1600)
   */
  async findWithGlobals(tenantId: string): Promise<FactSubject[]> {
    return queryWithGlobals<FactSubject>(
      this,
      tenantId,
      'FactSubject.findWithGlobals',
    );
  }
}
