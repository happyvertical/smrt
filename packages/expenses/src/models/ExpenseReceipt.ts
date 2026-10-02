/**
 * ExpenseReceipt — the expense-owned join between an {@link Expense} and the
 * smrt-assets `Asset` that proves it.
 *
 * @packageDocumentation
 */

import { AssetCollection } from '@happyvertical/smrt-assets';
import {
  classifyDatabaseError,
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
  effectiveTenant,
  identityConflict,
  normalizeSha256,
  normalizeTenantId,
  pinNaturalKey,
} from '../validation.js';
import { Expense } from './Expense.js';

/**
 * The unique index that refuses a second copy of a file on one expense. Kept
 * in step with the literal in the `@smrt()` indexes below (the scanner reads
 * that literal); the PostgreSQL schema test asserts the name.
 */
const RECEIPT_FILE_KEY = 'expense_receipts_expense_sha256_key';

/** The columns of {@link RECEIPT_FILE_KEY}; no other unique key uses them. */
const RECEIPT_FILE_COLUMNS = new Set(['expense_id', 'content_sha256']);

/**
 * The columns a unique violation reports. Core's typed write error carries
 * them in `details.fieldName` (recovered from PostgreSQL's
 * `Key (expense_id, content_sha256)=…` detail, or SQLite's column list) but
 * not the driver error itself, so this is where the violated key is named.
 */
function violatedColumns(error: unknown): string[] {
  const details = (error as { details?: { fieldName?: unknown } } | null)
    ?.details;
  const fieldName =
    typeof details?.fieldName === 'string' ? details.fieldName : '';
  return fieldName
    .split(',')
    .map((column) => column.trim())
    .filter(Boolean);
}

/**
 * Columns a receipt keeps for life: it is evidence, not a draft. The tenant
 * is among them because it is derived from the expense on insert; letting a
 * later save (e.g. one without tenant context) change it would split the
 * receipt from its expense's tenant.
 */
const IMMUTABLE = [
  ['tenantId', 'tenant_id'],
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
 *   on `(expense_id, content_sha256)` plus a pre-insert check that raises
 *   {@link DuplicateReceiptError}. The index leaves `tenant_id` out on
 *   purpose: an expense belongs to exactly one tenant, so the key is already
 *   tenant-scoped, and a NULL tenant would otherwise make every global row
 *   distinct and the index unenforced;
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
      name: 'expense_receipts_expense_sha256_key',
      columns: ['expenseId', 'contentSha256'],
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
    this.tenantId = normalizeTenantId(this.tenantId);
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
    const inserting = await pinNaturalKey('ExpenseReceipt', this, persisted);
    if (persisted) {
      const self = this as unknown as Record<string, unknown>;
      for (const [fieldName, column] of IMMUTABLE) {
        // The tenant is compared as it will be written: an empty tenantId
        // saved inside a tenant context is filled in by the interceptor.
        const value =
          fieldName === 'tenantId'
            ? effectiveTenant(this.tenantId)
            : self[fieldName];
        if (String(persisted[column] ?? '') !== String(value ?? '')) {
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
      if (inserting && isUniqueViolationError(error)) {
        throw await this.classifyInsertConflict(error);
      }
      throw error;
    }
  }

  /**
   * A refused INSERT is either the same file racing onto the same expense,
   * or a natural-key collision with another receipt.
   *
   * Classified from the error first, by the violated key's name or columns
   * (no other unique key on this table uses `expense_id` or
   * `content_sha256`). That matters inside a caller's transaction,
   * which the violation has already aborted on PostgreSQL, so nothing could
   * be re-read there. Only an adapter that reports neither falls back to a
   * re-read; if that re-read fails too, the original error is kept rather
   * than guessed at.
   */
  private async classifyInsertConflict(error: unknown): Promise<unknown> {
    const info = classifyDatabaseError(error);
    const columns = violatedColumns(error);
    if (
      info.constraint === RECEIPT_FILE_KEY ||
      info.driverMessages.some((text) => text.includes(RECEIPT_FILE_KEY)) ||
      columns.some((column) => RECEIPT_FILE_COLUMNS.has(column))
    ) {
      return new DuplicateReceiptError(this.expenseId, this.contentSha256, {
        cause: error,
      });
    }
    if (info.constraint || columns.length > 0) {
      // Another named key: the natural key or the primary key.
      return identityConflict('ExpenseReceipt', this, error);
    }
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
