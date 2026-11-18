/**
 * Collections for the accounting payment-sync and readback records (#5139).
 * Writes go through `accounting-payment-sync.ts`.
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import {
  AccountingInvoiceReadback,
  AccountingPaymentSync,
} from '../models/AccountingSyncRecords.js';

export class AccountingPaymentSyncCollection extends SmrtCollection<AccountingPaymentSync> {
  static readonly _itemClass = AccountingPaymentSync;

  /** @internal An unsaved record for the commands, which own every write. */
  async build(
    options: Parameters<SmrtCollection<AccountingPaymentSync>['create']>[0],
  ): Promise<AccountingPaymentSync> {
    return this.createUnsaved(options);
  }

  /** The push record for one payment in a company and environment, or `null`. */
  async findForPayment(args: {
    tenantId: string;
    realmId: string;
    environment: 'sandbox' | 'production';
    paymentId: string;
  }): Promise<AccountingPaymentSync | null> {
    const rows = await this.list({
      where: { ...args, provider: 'quickbooks' },
      limit: 2,
    });
    if (rows.length > 1) throw new Error('Duplicate accounting payment sync');
    return rows[0] ?? null;
  }
}

export class AccountingInvoiceReadbackCollection extends SmrtCollection<AccountingInvoiceReadback> {
  static readonly _itemClass = AccountingInvoiceReadback;

  /** @internal An unsaved record for the commands, which own every write. */
  async build(
    options: Parameters<SmrtCollection<AccountingInvoiceReadback>['create']>[0],
  ): Promise<AccountingInvoiceReadback> {
    return this.createUnsaved(options);
  }

  /** The stored readback of one invoice, or `null`. */
  async findForInvoice(
    tenantId: string,
    invoiceId: string,
  ): Promise<AccountingInvoiceReadback | null> {
    const rows = await this.list({ where: { tenantId, invoiceId }, limit: 2 });
    if (rows.length > 1) throw new Error('Duplicate accounting readback');
    return rows[0] ?? null;
  }
}
