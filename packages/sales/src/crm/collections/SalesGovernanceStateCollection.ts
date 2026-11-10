/** Tenant-filtered database serialization primitives for seller governance. */
import { SmrtCollection } from '@happyvertical/smrt-core';
import { requireTenantId } from '@happyvertical/smrt-tenancy';
import { SalesGovernanceState } from '../models/SalesGovernanceState.js';

import { assertGovernanceWrite } from '../services/governance-write.js';

export class SalesGovernanceStateCollection extends SmrtCollection<SalesGovernanceState> {
  static readonly _itemClass = SalesGovernanceState;

  /** Insert the shared resource fence without changing its current owner. */
  async ensure(id: string): Promise<void> {
    assertGovernanceWrite(this.db);
    await this.query(
      `INSERT INTO ${this.tableName} (id, slug, context, tenant_id, revision, payload)
       VALUES (?, ?, '', ?, 0, '{}') ON CONFLICT DO NOTHING`,
      [id, id, requireTenantId()],
      { allowRawOnTenantScoped: true },
    );
  }

  /** Serialize a resource on pooled adapters and reload its committed state. */
  async lock(id: string): Promise<SalesGovernanceState> {
    await this.ensure(id);
    assertGovernanceWrite(this.db);
    const rows = await this.query(
      `UPDATE ${this.tableName} SET revision = revision WHERE id = ? AND tenant_id = ? RETURNING id`,
      [id, requireTenantId()],
      { allowRawOnTenantScoped: true },
    );
    if (rows.length !== 1)
      throw new Error('Sales governance resource unavailable');
    const state = await this.get({ id }, { cache: false });
    if (!state) throw new Error('Sales governance resource unavailable');
    return state;
  }

  /** CAS is the cross-process serialization point; losers must retry the operation. */
  async compareAndSwap(
    id: string,
    revision: number,
    payload: string,
  ): Promise<boolean> {
    assertGovernanceWrite(this.db);
    const rows = await this.query(
      `UPDATE ${this.tableName} SET revision = revision + 1, payload = ?
       WHERE id = ? AND tenant_id = ? AND revision = ? RETURNING id`,
      [payload, id, requireTenantId(), revision],
      { allowRawOnTenantScoped: true },
    );
    return rows.length === 1;
  }
}
