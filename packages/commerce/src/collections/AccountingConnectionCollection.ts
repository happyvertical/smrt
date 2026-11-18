/**
 * AccountingConnectionCollection - tenant accounting connections (#5136).
 * Writes go through the accounting-connection commands; see
 * `agents/accounting-connection.md`.
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import {
  AccountingConnection,
  type AccountingConnectionProvider,
} from '../models/AccountingConnection.js';

export class AccountingConnectionCollection extends SmrtCollection<AccountingConnection> {
  static readonly _itemClass = AccountingConnection;

  /**
   * @internal An unsaved connection for the accounting-connection commands,
   * which own every write (`save()` refuses any other caller).
   */
  async build(
    options: Parameters<SmrtCollection<AccountingConnection>['create']>[0],
  ): Promise<AccountingConnection> {
    return this.createUnsaved(options);
  }

  /**
   * The tenant's connection for a provider, or `null`.
   *
   * @param args - Tenant and provider
   * @returns The connection or null
   */
  async findForTenant(args: {
    tenantId: string;
    provider: AccountingConnectionProvider;
  }): Promise<AccountingConnection | null> {
    const rows = await this.list({
      where: { tenantId: args.tenantId, provider: args.provider },
      limit: 2,
    });
    if (rows.length > 1)
      throw new Error(
        'Tenant has more than one accounting connection per provider',
      );
    return rows[0] ?? null;
  }
}
