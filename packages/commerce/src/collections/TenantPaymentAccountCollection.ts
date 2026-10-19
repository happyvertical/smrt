/**
 * TenantPaymentAccountCollection - collection for tenant-owned connected
 * payment accounts (#3831). Writes go through the connected-payments
 * commands; see `agents/connected-payments.md`.
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import {
  TenantPaymentAccount,
  type TenantPaymentEnvironment,
} from '../models/TenantPaymentAccount.js';

export class TenantPaymentAccountCollection extends SmrtCollection<TenantPaymentAccount> {
  static readonly _itemClass = TenantPaymentAccount;

  /**
   * @internal An unsaved account for the connected-payments commands, which
   * own every write (`save()` refuses any other caller).
   */
  async build(
    options: Parameters<SmrtCollection<TenantPaymentAccount>['create']>[0],
  ): Promise<TenantPaymentAccount> {
    return this.createUnsaved(options);
  }

  /**
   * The tenant's account for a backend and environment, or `null`.
   *
   * @param args - Tenant, backend and environment
   * @returns The account or null
   */
  async findForTenant(args: {
    tenantId: string;
    backendId: string;
    environment: TenantPaymentEnvironment;
  }): Promise<TenantPaymentAccount | null> {
    const rows = await this.list({
      where: {
        tenantId: args.tenantId,
        backendId: args.backendId,
        environment: args.environment,
      },
      limit: 2,
    });
    if (rows.length > 1)
      throw new Error('Tenant has more than one payment account per backend');
    return rows[0] ?? null;
  }
}
