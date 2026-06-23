/**
 * Commerce component types
 */

export type InvoiceStatus =
  | 'draft'
  | 'sent'
  | 'viewed'
  | 'paid'
  | 'overdue'
  | 'cancelled';

export interface InvoiceData {
  id: string;
  invoiceNumber: string;
  status: InvoiceStatus;
  issueDate: Date | string;
  dueDate?: Date | string | null;
  totalAmount: number;
  customerName?: string;
  projectName?: string;
}

export interface LineItem {
  /** Unique identifier */
  id: string;
  /** Item description */
  description: string;
  /** Quantity */
  quantity: number;
  /** Unit price in decimal dollars */
  unitPrice: number;
  /** Total amount in decimal dollars (quantity * unitPrice) */
  amount: number;
  /** Optional category */
  category?: string;
  /** Source type (expense, time, manual) */
  sourceType?: 'expense' | 'time' | 'manual';
}

export interface UnbilledItem {
  /** Unique identifier */
  id: string;
  /** Item type */
  type: 'expense' | 'time';
  /** Description */
  description: string;
  /** Date of item */
  date: Date | string;
  /** Amount in decimal dollars */
  amount: number;
  /** Category */
  category?: string;
  /** Selected state */
  selected?: boolean;
}
