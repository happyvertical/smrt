/**
 * ContractCollection - Collection manager for Contract objects (STI)
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Contract } from '../models/Contract.js';
import { ContractStatus, ContractType } from '../types/index.js';

export class ContractCollection extends SmrtCollection<Contract> {
  static readonly _itemClass = Contract;

  /**
   * Find contracts by customer
   *
   * @param customerId - Customer ID
   * @returns Array of contracts
   */
  async findByCustomer(customerId: string): Promise<Contract[]> {
    return await this.list({
      where: { customerId },
      orderBy: 'created_at DESC',
    });
  }

  /**
   * Find contracts by vendor
   *
   * @param vendorId - Vendor ID
   * @returns Array of contracts
   */
  async findByVendor(vendorId: string): Promise<Contract[]> {
    return await this.list({
      where: { vendorId },
      orderBy: 'created_at DESC',
    });
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
   * Find all global contracts (not associated with any tenant)
   *
   * @returns Array of global contracts
   */
  async findGlobal(): Promise<Contract[]> {
    return this.list({ where: { tenantId: null } });
  }

  /**
   * Find contracts for a tenant including global contracts
   *
   * @param tenantId - Tenant ID
   * @returns Array of tenant-specific and global contracts
   */
  async findWithGlobals(tenantId: string): Promise<Contract[]> {
    return this.query(
      `SELECT * FROM ${this.tableName} WHERE tenant_id = ? OR tenant_id IS NULL`,
      [tenantId],
    );
  }
}
