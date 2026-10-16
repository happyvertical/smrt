/**
 * InvoiceLineItemCollection - Collection manager for InvoiceLineItem objects
 * @packageDocumentation
 */

import {
  SmrtCollection,
  type SmrtListOptions,
  type SmrtObject,
  type SmrtSelectedRow,
  type SmrtSelectField,
  type SmrtStiReadScope,
  type SmrtWhereClause,
} from '@happyvertical/smrt-core';
import {
  getTenantId,
  queryGlobal,
  queryWithGlobals,
} from '@happyvertical/smrt-tenancy';
import { DOCUMENT_MONEY_READ_REBIND } from '../document-money-internal.js';
import { InvoiceLineItem } from '../models/InvoiceLineItem.js';
import { withTenantMoneyCollectionRead } from '../tenant-money-barrier.js';
import { assertCommerceMoneySchemaCurrent } from '../upgrade/detect.js';

export class InvoiceLineItemCollection extends SmrtCollection<InvoiceLineItem> {
  static readonly _itemClass = InvoiceLineItem;

  private async withMoneyRead<T>(operation: () => Promise<T>): Promise<T> {
    const rootDb = this.db;
    const tenantId = getTenantId();
    if (!tenantId) {
      // Without a tenant, still refuse a database with old money storage.
      await assertCommerceMoneySchemaCurrent(rootDb);
      return operation();
    }
    const result = await withTenantMoneyCollectionRead(
      rootDb,
      tenantId,
      (boundDb) => this.withDatabase(boundDb, operation),
    );
    if (result instanceof InvoiceLineItem)
      result.rebindMoneyRead(DOCUMENT_MONEY_READ_REBIND, rootDb);
    else if (Array.isArray(result))
      for (const item of result)
        if (item instanceof InvoiceLineItem)
          item.rebindMoneyRead(DOCUMENT_MONEY_READ_REBIND, rootDb);
    return result;
  }

  override async get(
    filter: string | SmrtWhereClause<InvoiceLineItem>,
    options: Parameters<SmrtCollection<InvoiceLineItem>['get']>[1] = {},
  ): Promise<InvoiceLineItem | null> {
    return this.withMoneyRead(() => super.get(filter, options));
  }

  override async list<
    const Select extends readonly SmrtSelectField<InvoiceLineItem>[],
  >(
    options: Omit<SmrtListOptions<InvoiceLineItem>, 'select' | 'stiScope'> & {
      select: Select;
      include?: never;
      stiScope: SmrtStiReadScope;
    },
  ): Promise<Record<string, unknown>[]>;
  override async list<
    const Select extends readonly SmrtSelectField<InvoiceLineItem>[],
  >(
    options: Omit<SmrtListOptions<InvoiceLineItem>, 'select' | 'stiScope'> & {
      select: Select;
      include?: never;
      stiScope?: undefined;
    },
  ): Promise<SmrtSelectedRow<InvoiceLineItem, Select>[]>;
  override async list(
    options: Omit<SmrtListOptions<InvoiceLineItem>, 'select' | 'stiScope'> & {
      select?: undefined;
      stiScope: SmrtStiReadScope;
    },
  ): Promise<SmrtObject[]>;
  override async list(options?: undefined): Promise<InvoiceLineItem[]>;
  override async list(
    options: Omit<SmrtListOptions<InvoiceLineItem>, 'select' | 'stiScope'> & {
      select?: undefined;
      stiScope?: undefined;
    },
  ): Promise<InvoiceLineItem[]>;
  override async list(
    options:
      | (Omit<SmrtListOptions<InvoiceLineItem>, 'select'> & {
          select?: undefined;
        })
      | undefined,
  ): Promise<SmrtObject[]>;
  override async list(
    options: SmrtListOptions<InvoiceLineItem> | undefined,
  ): Promise<SmrtObject[] | Record<string, unknown>[]>;
  override async list(
    options: SmrtListOptions<InvoiceLineItem> = {},
  ): Promise<SmrtObject[] | Record<string, unknown>[]> {
    return this.withMoneyRead(() => super.list(options));
  }

  /**
   * Find line items by invoice
   *
   * @param invoiceId - Invoice ID
   * @returns Array of line items, sorted by sortOrder
   */
  async findByInvoice(invoiceId: string): Promise<InvoiceLineItem[]> {
    return await this.list({
      where: { invoiceId },
      orderBy: 'sortOrder ASC',
    });
  }

  /**
   * Find line items by source
   *
   * @param sourceType - Source type (e.g., 'campaign', 'contract')
   * @param sourceId - Source ID
   * @returns Array of line items
   */
  async findBySource(
    sourceType: string,
    sourceId: string,
  ): Promise<InvoiceLineItem[]> {
    return await this.list({
      where: { sourceType, sourceId },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Find line items by source type only
   *
   * @param sourceType - Source type (e.g., 'campaign')
   * @returns Array of line items
   */
  async findBySourceType(sourceType: string): Promise<InvoiceLineItem[]> {
    return await this.list({
      where: { sourceType },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Calculate total amount for an invoice
   *
   * @param invoiceId - Invoice ID
   * @returns Total amount
   */
  async getTotalForInvoice(invoiceId: string): Promise<number> {
    const lineItems = await this.findByInvoice(invoiceId);
    return lineItems.reduce((sum, item) => sum + item.amount, 0);
  }

  /**
   * Get the next sort order for an invoice
   *
   * @param invoiceId - Invoice ID
   * @returns Next sort order number
   */
  async getNextSortOrder(invoiceId: string): Promise<number> {
    const lineItems = await this.findByInvoice(invoiceId);
    if (lineItems.length === 0) return 0;

    const maxSortOrder = Math.max(...lineItems.map((item) => item.sortOrder));
    return maxSortOrder + 1;
  }

  // ============================================================================
  // Tenant Helper Methods
  // ============================================================================

  /**
   * Find all invoice line items belonging to a specific tenant
   *
   * @param tenantId - Tenant ID
   * @returns Array of invoice line items for the tenant
   */
  async findByTenant(tenantId: string): Promise<InvoiceLineItem[]> {
    return this.list({ where: { tenantId } });
  }

  /**
   * Find all global invoice line items (not associated with any tenant).
   *
   * Routes through the shared tenant-global helper so it does not throw under
   * an active tenant context (an explicit `tenant_id IS NULL` filter would be
   * flagged as an isolation violation). (#1600)
   *
   * @returns Array of global invoice line items
   */
  async findGlobal(): Promise<InvoiceLineItem[]> {
    return queryGlobal<InvoiceLineItem>(this);
  }

  /**
   * Find invoice line items for a tenant including global line items.
   *
   * Fails closed if an active tenant context requests a different tenant's
   * rows; the admin/system path keeps the cross-tenant capability. (#1600)
   *
   * @param tenantId - Tenant ID
   * @returns Array of tenant-specific and global invoice line items
   */
  async findWithGlobals(tenantId: string): Promise<InvoiceLineItem[]> {
    return queryWithGlobals<InvoiceLineItem>(
      this,
      tenantId,
      'InvoiceLineItem.findWithGlobals',
    );
  }
}
