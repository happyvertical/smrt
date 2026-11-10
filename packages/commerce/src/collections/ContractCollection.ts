/**
 * ContractCollection - Collection manager for Contract objects (STI)
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
import {
  Contract,
  isContractSnapshotReportEligible,
} from '../models/Contract.js';
import { withTenantMoneyCollectionRead } from '../tenant-money-barrier.js';
import { ContractStatus, ContractType } from '../types/index.js';
import { assertCommerceMoneySchemaCurrent } from '../upgrade/detect.js';
import { PurchaseContractCollection } from './PurchaseContractCollection.js';
import { SalesContractCollection } from './SalesContractCollection.js';

export class ContractCollection extends SmrtCollection<Contract> {
  static readonly _itemClass = Contract;

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
    if (result instanceof Contract)
      result.rebindMoneyRead(DOCUMENT_MONEY_READ_REBIND, rootDb);
    else if (Array.isArray(result))
      for (const item of result)
        if (item instanceof Contract)
          item.rebindMoneyRead(DOCUMENT_MONEY_READ_REBIND, rootDb);
    return result;
  }

  override async get(
    filter: string | SmrtWhereClause<Contract>,
    options: Parameters<SmrtCollection<Contract>['get']>[1] = {},
  ): Promise<Contract | null> {
    return this.withMoneyRead(() => super.get(filter, options));
  }

  override async list<
    const Select extends readonly SmrtSelectField<Contract>[],
  >(
    options: Omit<SmrtListOptions<Contract>, 'select' | 'stiScope'> & {
      select: Select;
      include?: never;
      stiScope: SmrtStiReadScope;
    },
  ): Promise<Record<string, unknown>[]>;
  override async list<
    const Select extends readonly SmrtSelectField<Contract>[],
  >(
    options: Omit<SmrtListOptions<Contract>, 'select' | 'stiScope'> & {
      select: Select;
      include?: never;
      stiScope?: undefined;
    },
  ): Promise<SmrtSelectedRow<Contract, Select>[]>;
  override async list(
    options: Omit<SmrtListOptions<Contract>, 'select' | 'stiScope'> & {
      select?: undefined;
      stiScope: SmrtStiReadScope;
    },
  ): Promise<SmrtObject[]>;
  override async list(options?: undefined): Promise<Contract[]>;
  override async list(
    options: Omit<SmrtListOptions<Contract>, 'select' | 'stiScope'> & {
      select?: undefined;
      stiScope?: undefined;
    },
  ): Promise<Contract[]>;
  override async list(
    options:
      | (Omit<SmrtListOptions<Contract>, 'select'> & { select?: undefined })
      | undefined,
  ): Promise<SmrtObject[]>;
  override async list(
    options: SmrtListOptions<Contract> | undefined,
  ): Promise<SmrtObject[] | Record<string, unknown>[]>;
  override async list(
    options: SmrtListOptions<Contract> = {},
  ): Promise<SmrtObject[] | Record<string, unknown>[]> {
    return this.withMoneyRead(() => super.list(options));
  }

  /**
   * Find contracts by customer
   *
   * @param customerId - Customer ID
   * @returns Array of contracts
   * @deprecated Use SalesContractCollection.findByCustomer.
   */
  async findByCustomer(customerId: string): Promise<Contract[]> {
    const sales = await SalesContractCollection.create({
      ...this.options,
      db: this.db,
    });
    return sales.findByCustomer(customerId);
  }

  /**
   * Find contracts by vendor
   *
   * @param vendorId - Vendor ID
   * @returns Array of contracts
   * @deprecated Use PurchaseContractCollection.findByVendor.
   */
  async findByVendor(vendorId: string): Promise<Contract[]> {
    const purchases = await PurchaseContractCollection.create({
      ...this.options,
      db: this.db,
    });
    return purchases.findByVendor(vendorId);
  }

  /**
   * Hydrate a bounded tenant/date report candidate set once, retaining exact
   * STI descendants so callers can classify custom purchase types safely.
   */
  async listSnapshotReportContracts(options: {
    tenantId: string;
    from: Date;
    to: Date;
  }): Promise<Contract[]> {
    const contracts = await this.list({
      where: {
        tenantId: options.tenantId,
        'issueDate >=': options.from.toISOString(),
        'issueDate <=': options.to.toISOString(),
      },
      orderBy: 'issueDate ASC',
    });
    return contracts.filter(isContractSnapshotReportEligible);
  }

  /**
   * Find contracts by type (STI)
   *
   * @param contractType - Contract type
   * @returns Array of contracts
   */
  async findByType(contractType: ContractType): Promise<Contract[]> {
    return await this.list({
      where: { contractType },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Find contracts by status
   *
   * @param status - Contract status
   * @returns Array of contracts
   */
  async findByStatus(status: ContractStatus): Promise<Contract[]> {
    return await this.list({
      where: { status },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Find all draft contracts
   *
   * @returns Array of draft contracts
   */
  async findDrafts(): Promise<Contract[]> {
    return await this.findByStatus(ContractStatus.DRAFT);
  }

  /**
   * Find all accepted contracts
   *
   * @returns Array of accepted contracts
   */
  async findAccepted(): Promise<Contract[]> {
    return await this.findByStatus(ContractStatus.ACCEPTED);
  }

  /**
   * Find overdue contracts
   *
   * @returns Array of overdue contracts
   */
  async findOverdue(): Promise<Contract[]> {
    const now = new Date().toISOString();
    // Get all contracts past due date that aren't completed or cancelled
    const all = await this.list({
      where: {
        'dueDate <': now,
      },
      orderBy: 'dueDate ASC',
    });
    return all.filter(
      (c) =>
        c.status !== ContractStatus.COMPLETED &&
        c.status !== ContractStatus.CANCELLED,
    );
  }

  /**
   * Find expired estimates/quotes
   *
   * @returns Array of expired estimates
   */
  async findExpired(): Promise<Contract[]> {
    const now = new Date().toISOString();
    // Get estimates past expiry date that aren't accepted, declined, or cancelled
    const estimates = await this.list({
      where: {
        contractType: ContractType.ESTIMATE,
        'expiryDate <': now,
      },
      orderBy: 'expiryDate ASC',
    });
    return estimates.filter(
      (c) =>
        c.status !== ContractStatus.ACCEPTED &&
        c.status !== ContractStatus.DECLINED &&
        c.status !== ContractStatus.CANCELLED,
    );
  }

  /**
   * Find contracts in date range
   *
   * @param startDate - Start date
   * @param endDate - End date
   * @returns Array of contracts
   */
  async findByDateRange(startDate: Date, endDate: Date): Promise<Contract[]> {
    return await this.list({
      where: {
        'issueDate >=': startDate.toISOString(),
        'issueDate <=': endDate.toISOString(),
      },
      orderBy: 'issueDate DESC',
    });
  }

  // ============================================================================
  // Tenant Helper Methods
  // ============================================================================

  /**
   * Find all contracts belonging to a specific tenant
   *
   * @param tenantId - Tenant ID
   * @returns Array of contracts for the tenant
   */
  async findByTenant(tenantId: string): Promise<Contract[]> {
    return this.list({ where: { tenantId } });
  }

  /**
   * Find all global contracts (not associated with any tenant).
   *
   * Routes through the shared tenant-global helper so it does not throw under
   * an active tenant context (an explicit `tenant_id IS NULL` filter would be
   * flagged as an isolation violation). (#1600)
   *
   * @returns Array of global contracts
   */
  async findGlobal(): Promise<Contract[]> {
    return queryGlobal<Contract>(this);
  }

  /**
   * Find contracts for a tenant including global contracts.
   *
   * Fails closed if an active tenant context requests a different tenant's
   * rows; the admin/system path keeps the cross-tenant capability. (#1600)
   *
   * @param tenantId - Tenant ID
   * @returns Array of tenant-specific and global contracts
   */
  async findWithGlobals(tenantId: string): Promise<Contract[]> {
    return queryWithGlobals<Contract>(
      this,
      tenantId,
      'Contract.findWithGlobals',
    );
  }
}
