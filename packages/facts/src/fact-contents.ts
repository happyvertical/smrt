/**
 * FactContentCollection — junction collection for Fact ↔ Content links.
 *
 * Generic junction surface (byLeft/byRight/attach/detach/setLinks) comes from
 * `SmrtJunction`. The remaining methods are tenant-scoping helpers.
 */

import { SmrtJunction, smrt } from '@happyvertical/smrt-core';
import { queryGlobal, queryWithGlobals } from '@happyvertical/smrt-tenancy';
import { FactContent } from './fact-content';

// Decorator with empty config — only needed so the scanner detects the
// class (FRAMEWORK_BASE_CLASSES doesn't include SmrtJunction). Do NOT
// pass api/mcp/cli here: those flow through to the item class
// registration via ObjectRegistry.register(itemClass, {...config}) at
// registry.ts:3094 and would clobber FactContent's own @smrt config.
@smrt()
export class FactContentCollection extends SmrtJunction<FactContent> {
  static readonly _itemClass = FactContent;
  protected leftField = 'factId';
  protected rightField = 'contentId';
  // FactContent rows have no sort or position column.
  protected sortField: string | null = null;
  protected positionField: string | null = null;

  // ============================================
  // Tenant helpers
  // ============================================

  async findByTenant(tenantId: string): Promise<FactContent[]> {
    return this.list({ where: { tenantId } });
  }

  /**
   * Find all global (tenant-less) fact-content links.
   *
   * Routes through the shared tenant-global helper so it does not throw under
   * an active tenant context (an explicit `tenant_id IS NULL` filter would be
   * flagged as an isolation violation). (#1600)
   */
  async findGlobal(): Promise<FactContent[]> {
    return queryGlobal<FactContent>(this);
  }

  /**
   * Find fact-content links for a tenant including global links.
   *
   * Fails closed if an active tenant context requests a different tenant's
   * rows; the admin/system path keeps the cross-tenant capability. (#1600)
   */
  async findWithGlobals(tenantId: string): Promise<FactContent[]> {
    return queryWithGlobals<FactContent>(
      this,
      tenantId,
      'FactContent.findWithGlobals',
    );
  }
}
