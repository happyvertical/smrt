/**
 * ExpenseReceipt — the expense-owned join between an {@link Expense} and the
 * smrt-assets `Asset` that proves it.
 *
 * @packageDocumentation
 */

import { AssetCollection } from '@happyvertical/smrt-assets';
import {
  crossPackageRef,
  field,
  foreignKey,
  isUniqueViolationError,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  DuplicateReceiptError,
  ExpenseError,
  type ExpenseReceiptOptions,
} from '../types.js';
import {
  assertMinorUnits,
  identityConflict,
  normalizeSha256,
  pinNaturalKey,
} from '../validation.js';
import { Expense } from './Expense.js';

/** Columns a receipt keeps for life: it is evidence, not a draft. */
const IMMUTABLE = [
  ['expenseId', 'expense_id'],
  ['assetId', 'asset_id'],
  ['contentSha256', 'content_sha256'],
] as const;

/**
 * A receipt file attached to an expense.
 *
 * Asset ownership uses a noun-specific join (`expense_receipts`), not the
 * generic `AssetAssociation`. The file's SHA-256 is stored so:
 *
 * - the same file attached twice to one expense is refused — a unique index
 *   on `(tenant_id, expense_id, content_sha256)` plus a pre-insert check
 *   that raises {@link DuplicateReceiptError};
 * - the same file on two different expenses is allowed, and surfaced for a
 *   person to look at by `ExpenseReceiptCollection.findDuplicateReceipts()`.
 *
 * Attaching a receipt never changes the expense's review state. The receipt
 * takes its tenant from the expense, and its asset must be visible in that
 * tenant. The generated surface is closed, like {@link Expense}'s.
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'expense_receipts',
  api: { include: [] },
  mcp: { include: [] },
  cli: false,
  indexes: [
    {
      name: 'expense_receipts_tenant_expense_sha256_key',
      columns: ['tenantId', 'expenseId', 'contentSha256'],
      unique: true,
    },
    {
      name: 'expense_receipts_tenant_sha256_idx',
      columns: ['tenantId', 'contentSha256'],
    },
  ],
})
export class ExpenseReceipt extends SmrtObject {
  /** Owning tenant; always the expense's tenant. */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /** The expense this receipt proves. Deleting the expense removes the link. */
  @foreignKey(Expense, { required: true, onDelete: 'CASCADE' })
  expenseId: string = '';

  /** The smrt-assets `Asset` holding the file. */
  @crossPackageRef('@happyvertical/smrt-assets:Asset', { required: true })
  assetId: string = '';

  /** Profile that uploaded the file. */
  @crossPackageRef('@happyvertical/smrt-profiles:Profile')
  uploadedByProfileId: string | null = null;

  /** Original filename as uploaded. */
  @field({ type: 'text' })
  filename: string = '';

  /** MIME type of the file. */
  @field({ type: 'text' })
  mimeType: string = '';

  /** Size of the file in bytes. */
  @field({ type: 'integer' })
  byteCount: number = 0;

  /** Lowercase hex SHA-256 of the file's bytes. */
  @field({ type: 'text', required: true })
  contentSha256: string = '';

  constructor(options: ExpenseReceiptOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.expenseId !== undefined) this.expenseId = options.expenseId;
    if (options.assetId !== undefined) this.assetId = options.assetId;
    if (options.uploadedByProfileId !== undefined)
      this.uploadedByProfileId = options.uploadedByProfileId;
    if (options.filename !== undefined) this.filename = options.filename;
    if (options.mimeType !== undefined) this.mimeType = options.mimeType;
    if (options.byteCount !== undefined) this.byteCount = options.byteCount;
    if (options.contentSha256 !== undefined)
      this.contentSha256 = options.contentSha256;
  }

  /**
   * Validate the link, refuse a second copy of the same file on the same
   * expense, then persist. Never touches the expense.
   *
   * @throws {DuplicateReceiptError} when the expense already has this file.
   * @throws {ExpenseError} `EXPENSE_RECEIPT_INVALID` for a bad hash, a
   *   missing or foreign-tenant expense or asset, or a change to an
   *   immutable column.
   */
  override async save(): Promise<this> {
    const label = this.id || '<new>';
    this.contentSha256 = normalizeSha256(
      'ExpenseReceipt',
      label,
      this.contentSha256,
    );
    assertMinorUnits(
      'ExpenseReceipt',
      label,
      'byteCount',
      this.byteCount,
      'EXPENSE_RECEIPT_INVALID',
    );
    if (!this.expenseId || !this.assetId) {
      throw new ExpenseError(
        'EXPENSE_RECEIPT_INVALID',
        `ExpenseReceipt ${label}: expenseId and assetId are required.`,
      );
    }

    const persisted = this.id
      ? (((await this.db.get(this.tableName, { id: this.id })) as
          | Record<string, unknown>
          | undefined
          | null) ?? null)
      : null;
    // The checks below are against `persisted`; pin the write to that row.
    await pinNaturalKey('ExpenseReceipt', this, persisted);
    if (persisted) {
      const self = this as unknown as Record<string, unknown>;
      for (const [fieldName, column] of IMMUTABLE) {
        if (String(persisted[column] ?? '') !== String(self[fieldName] ?? '')) {
          throw new ExpenseError(
            'EXPENSE_RECEIPT_INVALID',
            `ExpenseReceipt ${this.id}: ${fieldName} cannot change; attach ` +
              'a new receipt instead.',
          );
        }
      }
    } else {
      await this.assertLinkTargets(label);
      await this.assertNotDuplicate();
    }

    try {
      return await super.save();
    } catch (error) {
      if (!persisted && isUniqueViolationError(error)) {
        throw await this.classifyInsertConflict(error);
      }
      throw error;
    }
  }

  /**
   * A refused INSERT is either the same file racing onto the same expense,
   * or a natural-key collision with another receipt. Re-read to tell which;
   * if the re-read itself fails (an aborted transaction), keep the original
   * error rather than guess.
   */
  private async classifyInsertConflict(error: unknown): Promise<unknown> {
    try {
      await this.assertNotDuplicate();
    } catch (duplicate) {
      if (duplicate instanceof DuplicateReceiptError) {
        return new DuplicateReceiptError(this.expenseId, this.contentSha256, {
          cause: error,
        });
      }
      return error;
    }
    return identityConflict('ExpenseReceipt', this, error);
  }

  private async assertLinkTargets(label: string): Promise<void> {
    const { ExpenseCollection } = await import(
      '../collections/ExpenseCollection.js'
    );
    const expenses = await ExpenseCollection.create({ db: this.db });
    const expense = await expenses.get({ id: this.expenseId });
    if (!expense) {
      throw new ExpenseError(
        'EXPENSE_RECEIPT_INVALID',
        `ExpenseReceipt ${label}: expense ${this.expenseId} was not found.`,
      );
    }
    if (this.tenantId === null || this.tenantId === undefined) {
      this.tenantId = expense.tenantId ?? null;
    }
    if ((this.tenantId ?? null) !== (expense.tenantId ?? null)) {
      throw new ExpenseError(
        'EXPENSE_RECEIPT_INVALID',
        `ExpenseReceipt ${label}: a receipt belongs to its expense's tenant.`,
      );
    }

    const assets = await AssetCollection.create({ db: this.db });
    const asset = await assets.get({ id: this.assetId });
    const assetTenant = asset?.tenantId ?? null;
    if (!asset || (assetTenant !== null && assetTenant !== this.tenantId)) {
      throw new ExpenseError(
        'EXPENSE_RECEIPT_INVALID',
        `ExpenseReceipt ${label}: asset ${this.assetId} was not found in ` +
          "the expense's tenant.",
      );
    }
    if (!this.filename) this.filename = asset.name ?? '';
    if (!this.mimeType) this.mimeType = asset.mimeType ?? '';
  }

  private async assertNotDuplicate(): Promise<void> {
    const { ExpenseReceiptCollection } = await import(
      '../collections/ExpenseReceiptCollection.js'
    );
    const receipts = await ExpenseReceiptCollection.create({ db: this.db });
    const existing = await receipts.list({
      where: {
        expenseId: this.expenseId,
        contentSha256: this.contentSha256,
      },
      limit: 1,
    });
    if (existing.length > 0) {
      throw new DuplicateReceiptError(this.expenseId, this.contentSha256);
    }
  }
}
