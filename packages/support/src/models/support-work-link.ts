/**
 * SupportWorkLink — links a Support Case to separately tracked internal work
 * (FR-29/FR-29a): a **Support Work Item** on the operational board, or a
 * **Development Work Item** created through a Delivery Handoff.
 *
 * Boundary: Support owns the Case and this link; Delivery Operations owns the
 * linked work's execution (agents, previews, merges, deployments). The
 * `status` field here is a read-only echo the delivery side reports back —
 * this package never drives the linked item's lifecycle. Targets are
 * addressed by qualified type + id (e.g. `@happyvertical/smrt-projects:Issue`)
 * so no runtime dependency on the owning package is needed.
 */

import {
  field,
  foreignKey,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { parseJsonField, type SupportWorkLinkKind } from '../types.js';

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'support_work_links',
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
  conflictColumns: ['case_id', 'target_type', 'target_id'],
})
export class SupportWorkLink extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @foreignKey('SupportCase', { required: true })
  caseId: string = '';

  @field({ type: 'text' })
  linkKind: SupportWorkLinkKind = 'support_work_item';

  /**
   * Qualified class of the linked work item, e.g.
   * `@happyvertical/smrt-projects:Issue`.
   */
  @field({ type: 'text' })
  targetType: string = '';

  @field({ type: 'text' })
  targetId: string = '';

  /** Display label for the case timeline (e.g. `repo#123: fix login`). */
  @field({ type: 'text' })
  targetLabel: string = '';

  @field({ type: 'text' })
  externalUrl: string = '';

  /**
   * Status echo reported back from the owning domain (`open`,
   * `in_progress`, `done`, …). Informational only.
   */
  @field({ type: 'text' })
  status: string = 'open';

  lastStatusAt: Date | null = null;

  @field({ type: 'text' })
  metadata: string = '{}';

  getMetadata(): Record<string, unknown> {
    return parseJsonField(this.metadata, {});
  }

  setMetadata(value: Record<string, unknown>): void {
    this.metadata = JSON.stringify(value ?? {});
  }
}

export class SupportWorkLinkCollection extends SmrtCollection<SupportWorkLink> {
  static readonly _itemClass = SupportWorkLink;

  async forCase(caseId: string): Promise<SupportWorkLink[]> {
    return this.list({ where: { caseId }, orderBy: 'created_at ASC' });
  }
}

export default SupportWorkLink;
