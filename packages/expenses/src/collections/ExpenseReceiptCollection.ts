/**
 * ExpenseReceiptCollection — attach receipts and find files shared between
 * expenses.
 *
 * @packageDocumentation
 */

import {
  type JunctionAttachOptions,
  SmrtJunction,
  smrt,
} from '@happyvertical/smrt-core';
import { ExpenseReceipt } from '../models/ExpenseReceipt.js';
import {
  type AttachReceiptInput,
  type DuplicateReceiptGroup,
  ExpenseError,
  type FindDuplicateReceiptsOptions,
} from '../types.js';

const DEFAULT_DUPLICATE_LIMIT = 100;
const MAX_DUPLICATE_LIMIT = 1000;

/**
 * Junction collection over `expense_receipts` (left: expense, right: asset).
 * Reads go through the normal tenant interceptors.
 *
 * Writes: {@link attachReceipt} adds a receipt; the inherited `detach()`
 * removes one (an explicit act; the asset itself is kept). The inherited
 * `attach()` and `setLinks()` are refused because they cannot carry the
 * content hash and `setLinks()` deletes before it writes.
 *
 * Collection classes are registered too, so this one carries its own closed
 * surface; without it every public method here would become an MCP tool.
 */
@smrt({ api: { include: [] }, mcp: { include: [] }, cli: false })
export class ExpenseReceiptCollection extends SmrtJunction<ExpenseReceipt> {
  static readonly _itemClass = ExpenseReceipt;
  protected leftField = 'expenseId';
  protected rightField = 'assetId';
  protected override sortField: string | null = 'createdAt';
  protected override positionField: string | null = null;

  /**
   * Attach a receipt file to an expense.
   *
   * Does not change the expense in any way — in particular not its review
   * state.
   *
   * @throws {DuplicateReceiptError} when this expense already carries a file
   *   with the same SHA-256.
   */
  async attachReceipt(input: AttachReceiptInput): Promise<ExpenseReceipt> {
    const receipt = await this.create({
      expenseId: input.expenseId,
      assetId: input.assetId,
      contentSha256: input.contentSha256,
      uploadedByProfileId: input.uploadedByProfileId ?? null,
      filename: input.filename ?? '',
      mimeType: input.mimeType ?? '',
      byteCount: input.byteCount ?? 0,
    });
    await receipt.save();
    return receipt;
  }

  /**
   * Refused: a receipt is evidence and needs its content hash, which a
   * generic junction attach does not carry. Use {@link attachReceipt}.
   *
   * @throws {ExpenseError} `EXPENSE_RECEIPT_INVALID`, always.
   */
  override async attach(
    _expenseId: string,
    _assetId: string,
    _opts: JunctionAttachOptions = {},
  ): Promise<ExpenseReceipt> {
    throw new ExpenseError(
      'EXPENSE_RECEIPT_INVALID',
      'ExpenseReceiptCollection.attach() is not supported: use ' +
        'attachReceipt(), which records and checks the file hash.',
    );
  }

  /**
   * Refused before anything is deleted. The inherited replace-all deletes
   * every receipt of the expense and re-attaches without hashes, which would
   * lose the evidence. Attach with {@link attachReceipt}; remove a link with
   * `detach()`.
   *
   * @throws {ExpenseError} `EXPENSE_RECEIPT_INVALID`, always.
   */
  override async setLinks(
    _expenseId: string,
    _assetIds: string[],
    _opts: JunctionAttachOptions = {},
  ): Promise<void> {
    throw new ExpenseError(
      'EXPENSE_RECEIPT_INVALID',
      'ExpenseReceiptCollection.setLinks() is not supported: it would delete ' +
        'receipt evidence. Use attachReceipt() to add and detach() to remove.',
    );
  }

  /** Receipts of one expense, oldest first. */
  async receiptsFor(expenseId: string): Promise<ExpenseReceipt[]> {
    return this.byLeft(expenseId);
  }

  /**
   * Files (by SHA-256) attached to more than one expense, for a person to
   * review. Nothing is changed or rejected: the same receipt on two expenses
   * may be a split cost or a double claim, and only a reviewer can tell.
   *
   * With `expenseId`, reports only files that expense shares with others;
   * without it, scans the visible tenant (largest groups first).
   */
  async findDuplicateReceipts(
    options: FindDuplicateReceiptsOptions = {},
  ): Promise<DuplicateReceiptGroup[]> {
    const limit = Math.min(
      Math.max(Math.trunc(options.limit ?? DEFAULT_DUPLICATE_LIMIT), 1),
      MAX_DUPLICATE_LIMIT,
    );

    let hashes: string[];
    if (options.expenseId) {
      const own = await this.byLeft(options.expenseId);
      hashes = [...new Set(own.map((receipt) => receipt.contentSha256))];
    } else {
      const [facet] = await this.facets({
        fields: [{ field: 'contentSha256', limit: MAX_DUPLICATE_LIMIT }],
      });
      // One row per (expense, hash) is enforced, so count > 1 means the
      // hash sits on more than one expense.
      hashes = (facet?.values ?? [])
        .filter((value) => value.count > 1)
        .map((value) => String(value.value));
    }
    hashes = hashes.slice(0, limit);
    if (hashes.length === 0) return [];

    const rows = await this.list({
      where: { contentSha256: hashes },
      orderBy: ['content_sha256 ASC', 'created_at ASC'],
    });
    const byHash = new Map<string, ExpenseReceipt[]>();
    for (const receipt of rows) {
      const group = byHash.get(receipt.contentSha256) ?? [];
      group.push(receipt);
      byHash.set(receipt.contentSha256, group);
    }

    const groups: DuplicateReceiptGroup[] = [];
    for (const [contentSha256, receipts] of byHash) {
      const expenseIds = [
        ...new Set(receipts.map((receipt) => receipt.expenseId)),
      ].sort();
      if (expenseIds.length < 2) continue;
      groups.push({ contentSha256, expenseIds, receipts });
    }
    groups.sort(
      (a, b) =>
        b.expenseIds.length - a.expenseIds.length ||
        a.contentSha256.localeCompare(b.contentSha256),
    );
    return groups.slice(0, limit);
  }
}
