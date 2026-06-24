/**
 * InvoiceLineItemCollection - Collection manager for InvoiceLineItem objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { queryGlobal, queryWithGlobals } from '@happyvertical/smrt-tenancy';
import { InvoiceLineItem } from '../models/InvoiceLineItem.js';
import type { AccountingLineItemInput } from '../types/index.js';

export class InvoiceLineItemCollection extends SmrtCollection<InvoiceLineItem> {
  static readonly _itemClass = InvoiceLineItem;

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
   * Calculate subtotal (before tax) for an invoice
   *
   * @param invoiceId - Invoice ID
   * @returns Subtotal
   */
  async getSubtotalForInvoice(invoiceId: string): Promise<number> {
    const lineItems = await this.findByInvoice(invoiceId);
    return lineItems.reduce((sum, item) => sum + item.getSubtotal(), 0);
  }

  /**
   * Calculate tax amount for an invoice
   *
   * @param invoiceId - Invoice ID
   * @returns Tax amount
   */
  async getTaxForInvoice(invoiceId: string): Promise<number> {
    const lineItems = await this.findByInvoice(invoiceId);
    return lineItems.reduce((sum, item) => sum + item.getTaxAmount(), 0);
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

  /**
   * Recalculate all line item amounts for an invoice
   *
   * @param invoiceId - Invoice ID
   * @returns Updated line items
   */
  async recalculateAmounts(invoiceId: string): Promise<InvoiceLineItem[]> {
    const lineItems = await this.findByInvoice(invoiceId);

    for (const item of lineItems) {
      item.amount = item.calculateAmount();
    }

    await Promise.all(lineItems.map((item) => item.save()));

    return lineItems;
  }

  /**
   * Convert line items to accounting format for SDK sync
   *
   * @param invoiceId - Invoice ID
   * @returns Array of line items in accounting format
   */
  async toAccountingLineItems(
    invoiceId: string,
  ): Promise<AccountingLineItemInput[]> {
    const lineItems = await this.findByInvoice(invoiceId);
    return lineItems.map((item) => item.toAccountingLineItem());
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
