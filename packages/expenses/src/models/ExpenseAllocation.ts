/** Immutable reviewed allocations and local invoice reservations. No generated surface. */
import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtObject,
  type SmrtObjectOptions,
  type SmrtSaveOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { allocationWrites } from '../allocation-internal.js';

export interface ExpenseAllocationRevisionOptions extends SmrtObjectOptions {
  kind?: 'allocation' | 'withdrawal';
  sourceCostObjectType?: string;
  sourceCostObjectId?: string;
  incurredOn?: string;
  paidBy?: 'company' | 'person' | 'third-party';
  reimbursable?: boolean;
  hasSupplierTax?: boolean | null;
  basisEqualsGross?: boolean;
  tenantId?: string;
  sourceExpenseId?: string;
  previousRevisionId?: string | null;
  requestId?: string;
  requestFingerprint?: string;
  sourceFingerprint?: string;
  sourceFingerprintNonce?: string;
  sourceRevision?: string;
  amountMinor?: number;
  currency?: string;
  reviewedByProfileId?: string;
  reviewedByUserId?: string;
  reviewEvidence?: string;
}
/** Persisted command-owned ExpenseAllocationRevision evidence. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'expense_allocation_revisions',
  api: { include: [] },
  mcp: { include: [] },
  cli: false,
  indexes: [
    {
      name: 'expense_allocation_request_key',
      columns: ['sourceExpenseId', 'requestId'],
      unique: true,
    },
    {
      name: 'expense_allocation_revision_successor',
      columns: ['previousRevisionId'],
      unique: true,
    },
  ],
})
export class ExpenseAllocationRevision extends SmrtObject {
  kind: 'allocation' | 'withdrawal' = 'allocation';
  /** Immutable bounded source facts retained even after unbilled withdrawal/correction. */
  sourceCostObjectType = '';
  sourceCostObjectId = '';
  incurredOn = '';
  paidBy: 'company' | 'person' | 'third-party' = 'company';
  reimbursable = false;
  @field({ type: 'boolean', nullable: true })
  hasSupplierTax: boolean | null = null;
  basisEqualsGross = false;
  @tenantId() tenantId = '';
  @foreignKey('Expense', {
    required: true,
    requiredFor: 'identity',
    onDelete: 'RESTRICT',
  })
  sourceExpenseId = '';
  @foreignKey('ExpenseAllocationRevision', {
    nullable: true,
    onDelete: 'RESTRICT',
  })
  previousRevisionId: string | null = null;
  requestId = '';
  requestFingerprint = '';
  sourceFingerprint = '';
  /** Secret to bounded portion readers; prevents low-entropy source-total guessing from its digest. */
  sourceFingerprintNonce = '';
  sourceRevision = '';
  @field({ type: 'integer' })
  amountMinor = 0;
  currency = '';
  @crossPackageRef('@happyvertical/smrt-profiles:Profile', { nullable: true })
  reviewedByProfileId: string | null = null;
  @crossPackageRef('@happyvertical/smrt-users:User', { nullable: true })
  reviewedByUserId: string | null = null;
  reviewEvidence = '';
  constructor(options: ExpenseAllocationRevisionOptions = {}) {
    super(options);
    for (const key of [
      'kind',
      'sourceCostObjectType',
      'sourceCostObjectId',
      'incurredOn',
      'paidBy',
      'reimbursable',
      'hasSupplierTax',
      'basisEqualsGross',
      'tenantId',
      'sourceExpenseId',
      'previousRevisionId',
      'requestId',
      'requestFingerprint',
      'sourceFingerprint',
      'sourceFingerprintNonce',
      'sourceRevision',
      'amountMinor',
      'currency',
      'reviewedByProfileId',
      'reviewedByUserId',
      'reviewEvidence',
    ] as const)
      if (options[key] !== undefined)
        Object.assign(this, { [key]: options[key] });
  }
  /** Refuse all writes except command-owned inserts, including same-id adoption. */
  override async save(options?: SmrtSaveOptions): Promise<this> {
    if (!allocationWrites.has(this) || !this.tenantId || this.isPersisted)
      throw new Error(
        'Expense allocation evidence is command-owned and immutable',
      );
    this.requireInsertOnSave();
    return super.save(options);
  }
  /** Evidence cannot be erased, including superseded revisions. */
  override async delete(): Promise<void> {
    throw new Error('Expense allocation evidence cannot be deleted');
  }
}

export interface ExpenseAllocationPortionOptions extends SmrtObjectOptions {
  tenantId?: string;
  sourceExpenseId?: string;
  revisionId?: string;
  portionKey?: string;
  costObjectType?: string;
  costObjectId?: string;
  costCodeRef?: string;
  amountMinor?: number;
  currency?: string;
}
/** Persisted command-owned ExpenseAllocationPortion evidence. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'expense_allocation_portions',
  api: { include: [] },
  mcp: { include: [] },
  cli: false,
  indexes: [
    {
      name: 'expense_allocation_portion_key',
      columns: ['revisionId', 'portionKey'],
      unique: true,
    },
  ],
})
export class ExpenseAllocationPortion extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Expense', {
    required: true,
    requiredFor: 'identity',
    onDelete: 'RESTRICT',
  })
  sourceExpenseId = '';
  @foreignKey('ExpenseAllocationRevision', {
    required: true,
    requiredFor: 'identity',
    onDelete: 'RESTRICT',
  })
  revisionId = '';
  portionKey = '';
  costObjectType = '';
  costObjectId = '';
  costCodeRef = '';
  @field({ type: 'integer' })
  amountMinor = 0;
  currency = '';
  constructor(options: ExpenseAllocationPortionOptions = {}) {
    super(options);
    for (const key of [
      'tenantId',
      'sourceExpenseId',
      'revisionId',
      'portionKey',
      'costObjectType',
      'costObjectId',
      'costCodeRef',
      'amountMinor',
      'currency',
    ] as const)
      if (options[key] !== undefined)
        Object.assign(this, { [key]: options[key] });
  }
  /** Refuse all writes except command-owned inserts, including same-id adoption. */
  override async save(options?: SmrtSaveOptions): Promise<this> {
    if (!allocationWrites.has(this) || !this.tenantId || this.isPersisted)
      throw new Error(
        'Expense allocation evidence is command-owned and immutable',
      );
    this.requireInsertOnSave();
    return super.save(options);
  }
  /** Evidence cannot be erased, including superseded revisions. */
  override async delete(): Promise<void> {
    throw new Error('Expense allocation evidence cannot be deleted');
  }
}

export interface ExpenseAllocationBillingOptions extends SmrtObjectOptions {
  tenantId?: string;
  sourceExpenseId?: string;
  portionId?: string;
  invoiceId?: string | null;
  draftType?: string;
  draftId?: string;
  invoiceLineId?: string | null;
  requestId?: string;
  requestFingerprint?: string;
  relatedReservationId?: string | null;
  kind?: string;
}
/** Persisted command-owned ExpenseAllocationBilling evidence. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'expense_allocation_billings',
  api: { include: [] },
  mcp: { include: [] },
  cli: false,
  indexes: [
    {
      name: 'expense_allocation_billing_request',
      columns: ['sourceExpenseId', 'requestId'],
      unique: true,
    },
    {
      name: 'expense_allocation_billing_release',
      columns: ['relatedReservationId', 'kind'],
      unique: true,
    },
  ],
})
export class ExpenseAllocationBilling extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Expense', {
    required: true,
    requiredFor: 'identity',
    onDelete: 'RESTRICT',
  })
  sourceExpenseId = '';
  @foreignKey('ExpenseAllocationPortion', {
    required: true,
    requiredFor: 'identity',
    onDelete: 'RESTRICT',
  })
  portionId = '';
  @crossPackageRef('@happyvertical/smrt-commerce:Invoice', { nullable: true })
  invoiceId: string | null = null;
  draftType = '';
  draftId = '';
  @crossPackageRef('@happyvertical/smrt-commerce:InvoiceLineItem', {
    nullable: true,
  })
  invoiceLineId: string | null = null;
  requestId = '';
  requestFingerprint = '';
  @foreignKey('ExpenseAllocationBilling', {
    nullable: true,
    onDelete: 'RESTRICT',
  })
  relatedReservationId: string | null = null;
  kind = 'reserve';
  constructor(options: ExpenseAllocationBillingOptions = {}) {
    super(options);
    for (const key of [
      'tenantId',
      'sourceExpenseId',
      'portionId',
      'invoiceId',
      'draftType',
      'draftId',
      'invoiceLineId',
      'requestId',
      'requestFingerprint',
      'relatedReservationId',
      'kind',
    ] as const)
      if (options[key] !== undefined)
        Object.assign(this, { [key]: options[key] });
  }
  /** Refuse all writes except command-owned inserts, including same-id adoption. */
  override async save(options?: SmrtSaveOptions): Promise<this> {
    if (!allocationWrites.has(this) || !this.tenantId || this.isPersisted)
      throw new Error(
        'Expense allocation evidence is command-owned and immutable',
      );
    this.requireInsertOnSave();
    return super.save(options);
  }
  /** Evidence cannot be erased, including superseded revisions. */
  override async delete(): Promise<void> {
    throw new Error('Expense allocation evidence cannot be deleted');
  }
}
