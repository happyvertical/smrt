/**
 * FactContentCollection — junction collection for Fact ↔ Content links.
 *
 * Generic junction surface (byLeft/byRight/attach/detach/setLinks) comes from
 * `SmrtJunction`. The remaining methods are tenant-scoping helpers.
 */

import { SmrtJunction, smrt } from '@happyvertical/smrt-core';
import { FactContent } from './fact-content';

@smrt({
  api: false,
  mcp: false,
  cli: false,
})
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
