/** Private transactional state for advertiser leases and governed quotes. */
import {
  SmrtObject,
  type SmrtObjectOptions,
  type SmrtSaveOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

import { assertGovernanceWrite } from '../services/governance-write.js';

export interface SalesGovernanceStateOptions extends SmrtObjectOptions {
  tenantId?: string;
  revision?: number;
  payload?: string;
}

/** Service-owned compare-and-swap fence. Migrate through the SMRT manifest. */
@TenantScoped({ mode: 'required' })
@smrt({ api: false, mcp: false, cli: false })
export class SalesGovernanceState extends SmrtObject {
  @tenantId()
  tenantId: string = '';
  revision: number = 0;
  payload: string = '{}';

  constructor(options: SalesGovernanceStateOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.revision !== undefined) this.revision = options.revision;
    if (options.payload !== undefined) this.payload = options.payload;
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    assertGovernanceWrite(this.db);
    return super.save(options);
  }
  override async delete(): Promise<void> {
    throw new Error('Sales governance state is service-owned');
  }
}
