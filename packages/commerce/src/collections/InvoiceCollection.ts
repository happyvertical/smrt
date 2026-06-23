/**
 * InvoiceCollection - Collection manager for Invoice objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { queryGlobal, queryWithGlobals } from '@happyvertical/smrt-tenancy';
import { Invoice } from '../models/Invoice.js';
import { InvoiceStatus } from '../types/index.js';

/**
 * Statuses that indicate an invoice has outstanding balance.
 * Used for calculating outstanding amounts and finding unpaid invoices.
 */
export const UNPAID_STATUSES = [
  InvoiceStatus.SENT,
  InvoiceStatus.VIEWED,
  InvoiceStatus.PARTIAL,
  InvoiceStatus.OVERDUE,
] as const;

/**
 * Options for generating invoice numbers
 */
export interface InvoiceNumberOptions {
  /** Prefix for invoice numbers (default: 'INV') */
  prefix?: string;
  /** Format: 'prefix-year-seq' or 'prefix-seq' (default: 'prefix-year-seq') */
  format?: 'prefix-year-seq' | 'prefix-seq';
}

export class InvoiceCollection extends SmrtCollection<Invoice> {
  static readonly _itemClass = Invoice;

  /**
   * Find invoices by customer
   *
   * @param customerId - Customer ID
   * @returns Array of invoices
   */
  async findByCustomer(customerId: string): Promise<Invoice[]> {
    return await this.list({
      where: { customerId },
      orderBy: 'issueDate DESC',
    });
  }

  /**
   * Find invoices by contract
   *
   * @param contractId - Contract ID
   * @returns Array of invoices
   */
  async findByContract(contractId: string): Promise<Invoice[]> {
    return await this.list({
      where: { contractId },
      orderBy: 'issueDate DESC',
    });
  }

  /**
   * Find invoices by status
   *
   * @param status - Invoice status
   * @returns Array of invoices
   */
  async findByStatus(status: InvoiceStatus): Promise<Invoice[]> {
    return await this.list({
      where: { status },
      orderBy: 'issueDate DESC',
    });
  }

  /**
   * Find all draft invoices
   *
   * @returns Array of draft invoices
   */
  async findDrafts(): Promise<Invoice[]> {
    return await this.findByStatus(InvoiceStatus.DRAFT);
  }

  /**
   * Find all sent invoices
   *
   * @returns Array of sent invoices
   */
  async findSent(): Promise<Invoice[]> {
    return await this.findByStatus(InvoiceStatus.SENT);
  }

  /**
   * Find all paid invoices
   *
   * @returns Array of paid invoices
   */
  async findPaid(): Promise<Invoice[]> {
    return await this.findByStatus(InvoiceStatus.PAID);
  }

  /**
   * Find all partial invoices
   *
   * @returns Array of partially paid invoices
   */
  async findPartial(): Promise<Invoice[]> {
    return await this.findByStatus(InvoiceStatus.PARTIAL);
  }

  /**
   * Find overdue invoices (past due date, not paid).
   *
   * **Note**: This method finds invoices by date, but does not automatically
   * update their status to OVERDUE. Use a background job or scheduled task
   * to periodically update invoice statuses based on due dates.
   *
   * @returns Array of overdue invoices
   */
  async findOverdue(): Promise<Invoice[]> {
    const now = new Date().toISOString();

    // Get invoices that are sent/viewed/partial and past due
    const candidates = await this.list({
      where: {
        'dueDate <': now,
      },
      orderBy: 'dueDate ASC',
    });

    return candidates.filter((inv) =>
      (UNPAID_STATUSES as readonly InvoiceStatus[]).includes(inv.status),
    );
  }

  /**
   * Find invoices in date range (by issue date)
   *
   * @param startDate - Start date
   * @param endDate - End date
   * @returns Array of invoices
   */
  async findByDateRange(startDate: Date, endDate: Date): Promise<Invoice[]> {
    return await this.list({
      where: {
        'issueDate >=': startDate.toISOString(),
        'issueDate <=': endDate.toISOString(),
      },
      orderBy: 'issueDate DESC',
    });
  }

  /**
   * Find invoice by external ID (from accounting provider)
   *
   * @param externalId - External ID
   * @returns Invoice or null
   */
  async findByExternalId(externalId: string): Promise<Invoice | null> {
    const results = await this.list({
      where: { externalId },
      limit: 1,
    });
    return results[0] || null;
  }

  /**
   * Find invoices needing sync to external provider
   * (no externalId or stale syncedAt)
   *
   * @returns Array of invoices needing sync
   */
  async findNeedingSync(): Promise<Invoice[]> {
    // Get all non-draft invoices without externalId
    const allInvoices = await this.list({
      orderBy: 'issueDate DESC',
    });

    return allInvoices.filter(
      (inv) =>
        inv.status !== InvoiceStatus.DRAFT &&
        inv.status !== InvoiceStatus.CANCELLED &&
        !inv.externalId,
    );
  }

  /**
   * Find invoice by invoice number
   *
   * @param invoiceNumber - Invoice number
   * @returns Invoice or null
   */
  async findByNumber(invoiceNumber: string): Promise<Invoice | null> {
    const results = await this.list({
      where: { invoiceNumber },
      limit: 1,
    });
    return results[0] || null;
  }

  /**
   * Count invoices for a given year
   *
   * @param year - Year to count
   * @returns Number of invoices
   */
  async countForYear(year: number): Promise<number> {
    const startDate = new Date(year, 0, 1).toISOString();
    const endDate = new Date(year + 1, 0, 1).toISOString();

    const invoices = await this.list({
      where: {
        'issueDate >=': startDate,
        'issueDate <': endDate,
      },
    });

    return invoices.length;
  }

  /**
   * Generate the next invoice number.
   *
   * **Warning**: This method has a potential race condition if multiple
   * invoices are created concurrently. For high-concurrency environments,
   * consider using a database sequence or atomic counter instead.
   *
   * @param options - Optional configuration for number format
   * @returns Generated invoice number (e.g., 'INV-2025-0001')
   *
   * @example
   * ```typescript
   * // Default format: INV-2025-0001
   * const num = await invoices.generateInvoiceNumber();
   *
   * // Custom prefix: BILL-2025-0001
   * const num = await invoices.generateInvoiceNumber({ prefix: 'BILL' });
   *
   * // Simple sequential: INV-000001
   * const num = await invoices.generateInvoiceNumber({ format: 'prefix-seq' });
   * ```
   */
  async generateInvoiceNumber(
    options: InvoiceNumberOptions = {},
  ): Promise<string> {
    const prefix = options.prefix || 'INV';
    const format = options.format || 'prefix-year-seq';

    const year = new Date().getFullYear();

    if (format === 'prefix-year-seq') {
      const count = await this.countForYear(year);
      const seq = String(count + 1).padStart(4, '0');
      return `${prefix}-${year}-${seq}`;
    }

    // Simple sequential format
    const allInvoices = await this.list({});
    const seq = String(allInvoices.length + 1).padStart(6, '0');
    return `${prefix}-${seq}`;
  }

  /**
   * Get total outstanding (unpaid) amount for a customer
   *
   * @param customerId - Customer ID
   * @returns Total amount due
   */
  async getTotalOutstandingForCustomer(customerId: string): Promise<number> {
    const invoices = await this.list({
      where: { customerId },
    });

    return invoices
      .filter((inv) =>
        (UNPAID_STATUSES as readonly InvoiceStatus[]).includes(inv.status),
      )
      .reduce((sum, inv) => sum + inv.getAmountDue(), 0);
  }

  // ============================================================================
  // Tenant Helper Methods
  // ============================================================================

  /**
   * Find all invoices belonging to a specific tenant
   *
   * @param tenantId - Tenant ID
   * @returns Array of invoices for the tenant
   */
  async findByTenant(tenantId: string): Promise<Invoice[]> {
    return this.list({ where: { tenantId } });
  }

  /**
   * Find all global invoices (not associated with any tenant).
   *
   * Routes through the shared tenant-global helper so it does not throw under
   * an active tenant context (an explicit `tenant_id IS NULL` filter would be
   * flagged as an isolation violation). (#1600)
   *
   * @returns Array of global invoices
   */
  async findGlobal(): Promise<Invoice[]> {
    return queryGlobal<Invoice>(this);
  }

  /**
   * Find invoices for a tenant including global invoices.
   *
   * Fails closed if an active tenant context requests a different tenant's
   * rows; the admin/system path keeps the cross-tenant capability. (#1600)
   *
   * @param tenantId - Tenant ID
   * @returns Array of tenant-specific and global invoices
   */
  async findWithGlobals(tenantId: string): Promise<Invoice[]> {
    return queryWithGlobals<Invoice>(this, tenantId, 'Invoice.findWithGlobals');
  }
}
