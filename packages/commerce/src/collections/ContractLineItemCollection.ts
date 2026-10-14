/**
 * ContractLineItemCollection - Collection manager for ContractLineItem objects
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
import { ContractLineItem } from '../models/ContractLineItem.js';
import { withTenantMoneyRuntime } from '../tenant-money-barrier.js';

export class ContractLineItemCollection extends SmrtCollection<ContractLineItem> {
  static readonly _itemClass = ContractLineItem;

  private async withMoneyRead<T>(operation: () => Promise<T>): Promise<T> {
    const rootDb = this.db;
    const tenantId = getTenantId();
    if (!tenantId) return operation();
    const result = await withTenantMoneyRuntime(
      rootDb,
      tenantId,
      'legacy-or-v2',
      (scope) => this.withDatabase(scope.db, operation),
    );
    if (result instanceof ContractLineItem)
      result.rebindMoneyRead(DOCUMENT_MONEY_READ_REBIND, rootDb);
    else if (Array.isArray(result))
      for (const item of result)
        if (item instanceof ContractLineItem)
          item.rebindMoneyRead(DOCUMENT_MONEY_READ_REBIND, rootDb);
    return result;
  }

  override async get(
    filter: string | SmrtWhereClause<ContractLineItem>,
    options: Parameters<SmrtCollection<ContractLineItem>['get']>[1] = {},
  ): Promise<ContractLineItem | null> {
    return this.withMoneyRead(() => super.get(filter, options));
  }

  override async list<
    const Select extends readonly SmrtSelectField<ContractLineItem>[],
  >(
    options: Omit<SmrtListOptions<ContractLineItem>, 'select' | 'stiScope'> & {
      select: Select;
      include?: never;
      stiScope: SmrtStiReadScope;
    },
  ): Promise<Record<string, unknown>[]>;
  override async list<
    const Select extends readonly SmrtSelectField<ContractLineItem>[],
  >(
    options: Omit<SmrtListOptions<ContractLineItem>, 'select' | 'stiScope'> & {
      select: Select;
      include?: never;
      stiScope?: undefined;
    },
  ): Promise<SmrtSelectedRow<ContractLineItem, Select>[]>;
  override async list(
    options: Omit<SmrtListOptions<ContractLineItem>, 'select' | 'stiScope'> & {
      select?: undefined;
      stiScope: SmrtStiReadScope;
    },
  ): Promise<SmrtObject[]>;
  override async list(options?: undefined): Promise<ContractLineItem[]>;
  override async list(
    options: Omit<SmrtListOptions<ContractLineItem>, 'select' | 'stiScope'> & {
      select?: undefined;
      stiScope?: undefined;
    },
  ): Promise<ContractLineItem[]>;
  override async list(
    options:
      | (Omit<SmrtListOptions<ContractLineItem>, 'select'> & {
          select?: undefined;
        })
      | undefined,
  ): Promise<SmrtObject[]>;
  override async list(
    options: SmrtListOptions<ContractLineItem> | undefined,
  ): Promise<SmrtObject[] | Record<string, unknown>[]>;
  override async list(
    options: SmrtListOptions<ContractLineItem> = {},
  ): Promise<SmrtObject[] | Record<string, unknown>[]> {
    return this.withMoneyRead(() => super.list(options));
  }

  /**
   * Find contract line items by their parent contract.
   *
   * @param contractId - Contract ID
   * @returns Array of contract line items, sorted by sortOrder
   */
  async findByContract(contractId: string): Promise<ContractLineItem[]> {
    return await this.list({
      where: { contractId },
      orderBy: 'sortOrder ASC',
    });
  }

  // ============================================================================
  // Tenant Helper Methods
  // ============================================================================

  /**
   * Find all contract line items belonging to a specific tenant
   *
   * @param tenantId - Tenant ID
   * @returns Array of contract line items for the tenant
   */
  async findByTenant(tenantId: string): Promise<ContractLineItem[]> {
    return this.list({ where: { tenantId } });
  }

  /**
   * Find all global contract line items (not associated with any tenant).
   *
   * Routes through the shared tenant-global helper so it does not throw under
   * an active tenant context (an explicit `tenant_id IS NULL` filter would be
   * flagged as an isolation violation). (#1600)
   *
   * @returns Array of global contract line items
   */
  async findGlobal(): Promise<ContractLineItem[]> {
    return queryGlobal<ContractLineItem>(this);
  }

  /**
   * Find contract line items for a tenant including global line items.
   *
   * Fails closed if an active tenant context requests a different tenant's
   * rows; the admin/system path keeps the cross-tenant capability. (#1600)
   *
   * @param tenantId - Tenant ID
   * @returns Array of tenant-specific and global contract line items
   */
  async findWithGlobals(tenantId: string): Promise<ContractLineItem[]> {
    return queryWithGlobals<ContractLineItem>(
      this,
      tenantId,
      'ContractLineItem.findWithGlobals',
    );
  }
}
