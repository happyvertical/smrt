/**
 * FactContentCollection — junction collection for Fact ↔ Content links.
 *
 * Generic junction surface (byLeft/byRight/attach/detach/setLinks) comes from
 * `SmrtJunction`. The remaining methods are tenant-scoping helpers.
 */

import { SmrtJunction, smrt } from '@happyvertical/smrt-core';
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

  async findGlobal(): Promise<FactContent[]> {
    return this.list({ where: { tenantId: null } });
  }

  async findWithGlobals(tenantId: string): Promise<FactContent[]> {
    return this.query(
      `SELECT * FROM ${this.tableName} WHERE tenant_id = ? OR tenant_id IS NULL`,
      [tenantId],
    );
  }
}
