/**
 * Expense — a cost someone incurred, against a cost object, with a review
 * state and optional reimbursement and commitment links.
 *
 * @packageDocumentation
 */

import {
  ContractCollection,
  ContractLineItemCollection,
  VendorCollection,
} from '@happyvertical/smrt-commerce';
import {
  crossPackageRef,
  field,
  foreignKey,
  isUniqueViolationError,
  ObjectRegistry,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  ExpenseError,
  type ExpenseOptions,
  type ExpensePayer,
  type ExpenseReviewStatus,
  type MarkDuplicateExpenseInput,
  type MarkReimbursedInput,
  type RejectExpenseInput,
  type ReopenExpenseInput,
  type ReviewExpenseInput,
} from '../types.js';
import {
  assertIsoCurrency,
  assertIsoDate,
  assertMinorUnits,
  assertQualifiedClassName,
  CATEGORY_PATTERN,
  effectiveTenant,
  identityConflict,
  instantMs,
  normalizeTenantId,
  pinNaturalKey,
} from '../validation.js';

const PROFILE = '@happyvertical/smrt-profiles:Profile';

/**
 * Legal review moves, keyed by the persisted status. Only the dedicated
 * methods perform them; `save()` refuses a review-field change they did not
 * authorize.
 */
const REVIEW_TRANSITIONS: Record<
  'review' | 'reject' | 'markDuplicate' | 'reopen',
  { from: readonly ExpenseReviewStatus[]; to: ExpenseReviewStatus }
> = {
  review: { from: ['unreviewed'], to: 'reviewed' },
  reject: { from: ['unreviewed', 'reviewed'], to: 'rejected' },
  markDuplicate: { from: ['unreviewed', 'reviewed'], to: 'rejected' },
  reopen: { from: ['reviewed', 'rejected'], to: 'unreviewed' },
};

/**
 * Fields a reviewed expense freezes. Changing one needs `reopen()` first, so
 * a reviewed amount can never move without a fresh review.
 */
const LOCKED_WHEN_REVIEWED = [
  ['amount', 'amount'],
  ['currency', 'currency'],
  ['incurredOn', 'incurred_on'],
  ['recordedAt', 'recorded_at'],
  ['category', 'category'],
  ['costObjectType', 'cost_object_type'],
  ['costObjectId', 'cost_object_id'],
  ['vendorId', 'vendor_id'],
  ['commitmentId', 'commitment_id'],
  ['commitmentLineId', 'commitment_line_id'],
  ['paidBy', 'paid_by'],
  ['paidByProfileId', 'paid_by_profile_id'],
] as const;

/** The review transition a dedicated method has authorized for one save. */
const authorizedTransition = new WeakMap<
  Expense,
  { from: ExpenseReviewStatus; expected: ReviewFieldState }
>();

/** Every review field, normalized for comparison. */
interface ReviewFieldState {
  status: ExpenseReviewStatus;
  reviewer: string | null;
  reviewedAtMs: number | null;
  note: string;
  duplicateOf: string | null;
}

function sameReviewState(a: ReviewFieldState, b: ReviewFieldState): boolean {
  return (
    a.status === b.status &&
    a.reviewer === b.reviewer &&
    a.reviewedAtMs === b.reviewedAtMs &&
    a.note === b.note &&
    a.duplicateOf === b.duplicateOf
  );
}

type PersistedRow = Record<string, unknown>;

function asNullableString(value: unknown): string | null {
  return value === null || value === undefined || value === ''
    ? null
    : String(value);
}

/**
 * A cost someone incurred.
 *
 * - **Cost object** — polymorphic `(costObjectType, costObjectId)`: a job, a
 *   work package, a project, any registered SMRT object. Exactly one per
 *   expense, so a cost is never rolled up into two jobs.
 * - **Money** — `amount` in integer minor units with an ISO 4217 `currency`.
 * - **Dates** — `incurredOn` (calendar date, `YYYY-MM-DD`) is when the cost
 *   happened; `recordedAt` is when it was entered.
 * - **Review** — `unreviewed → reviewed | rejected`, only through
 *   {@link Expense.review}, {@link Expense.reject},
 *   {@link Expense.markDuplicate} and {@link Expense.reopen}. A plain field
 *   write to the review state is refused on save.
 * - **Reimbursement** — recording only: whether a person who paid is owed
 *   back and when they were paid. Never changes review state.
 * - **Commitment** — optional commerce `Contract` (usually a `PurchaseOrder`)
 *   or one of its lines that this actual draws down.
 *
 * The generated REST/MCP/CLI surface is closed (`api: { include: [] }`):
 * cost visibility is permission-gated by every consumer, so they expose
 * expenses through their own routes and call the domain methods here.
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'expenses',
  api: { include: [] },
  mcp: { include: [] },
  cli: false,
  indexes: [
    {
      name: 'expenses_cost_object_idx',
      columns: ['tenantId', 'costObjectType', 'costObjectId', 'incurredOn'],
    },
    {
      name: 'expenses_commitment_review_idx',
      columns: ['tenantId', 'commitmentId', 'reviewStatus'],
    },
    {
      name: 'expenses_review_status_idx',
      columns: ['tenantId', 'reviewStatus', 'incurredOn'],
    },
  ],
})
export class Expense extends SmrtObject {
  /** Owning tenant. Nullable: optional tenancy, like every commerce model. */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Qualified class of the cost object, e.g.
   * `@happyvertical/smrt-projects:Project`. Empty only for an unallocated
   * expense (then `costObjectId` is empty too).
   */
  @field({ type: 'text' })
  costObjectType: string = '';

  /** Id of the cost object. Bare string: the target table is polymorphic. */
  @field({ type: 'text' })
  costObjectId: string = '';

  /**
   * Lowercase kebab-case category. See `SUGGESTED_EXPENSE_CATEGORIES`;
   * any value matching the pattern is accepted.
   */
  @field({ type: 'text' })
  category: string = 'other';

  /** What was bought or paid for. */
  @field({ type: 'text' })
  description: string = '';

  /** Amount in integer minor units (cents). `= 0` makes the column INTEGER. */
  @field({ type: 'integer' })
  amount: number = 0;

  /** ISO 4217 currency code, upper case. Required. */
  @field({ type: 'text' })
  currency: string = '';

  /** Calendar date the cost was incurred, `YYYY-MM-DD`. Required. */
  @field({ type: 'text' })
  incurredOn: string = '';

  /** When the expense was recorded; set on first save when empty. */
  recordedAt: Date | null = null;

  /** Profile that recorded the expense. */
  @crossPackageRef(PROFILE)
  recordedByProfileId: string | null = null;

  /** `company`, or `person` (then {@link Expense.paidByProfileId} is set). */
  @field({ type: 'text' })
  paidBy: ExpensePayer = 'company';

  /** Profile that paid out of pocket; required when `paidBy` is `person`. */
  @crossPackageRef(PROFILE)
  paidByProfileId: string | null = null;

  /** Optional commerce vendor the cost was paid to. */
  @crossPackageRef('@happyvertical/smrt-commerce:Vendor')
  vendorId: string | null = null;

  /**
   * Optional commitment this actual draws down: a commerce `Contract`
   * (normally a `PurchaseOrder`). Must be in the same currency and tenant.
   */
  @crossPackageRef('@happyvertical/smrt-commerce:Contract')
  commitmentId: string | null = null;

  /** Optional line of {@link Expense.commitmentId} this actual draws down. */
  @crossPackageRef('@happyvertical/smrt-commerce:ContractLineItem')
  commitmentLineId: string | null = null;

  /** Review state. Changed only by the review methods. */
  @field({ type: 'text', readonly: true })
  reviewStatus: ExpenseReviewStatus = 'unreviewed';

  /** Profile that made the current review decision. */
  @crossPackageRef(PROFILE, { readonly: true })
  reviewedByProfileId: string | null = null;

  /** When the current review decision was made. */
  @field({ type: 'datetime', readonly: true })
  reviewedAt: Date | null = null;

  /** Review note or rejection reason. */
  @field({ type: 'text', readonly: true })
  reviewNote: string = '';

  /**
   * Set when a reviewer marked this expense a duplicate of another one. A
   * duplicate is `rejected` and never counts toward any total.
   */
  @foreignKey('Expense', { readonly: true, onDelete: 'SET NULL' })
  duplicateOfId: string | null = null;

  /** Whether the person who paid is owed the amount back. */
  @field({ type: 'boolean' })
  reimbursable: boolean = false;

  /** When the person was paid back; set by {@link Expense.markReimbursed}. */
  reimbursedAt: Date | null = null;

  /** Payroll line, payables reference, or transfer id of the payback. */
  @field({ type: 'text' })
  reimbursementReference: string = '';

  constructor(options: ExpenseOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.costObjectType !== undefined)
      this.costObjectType = options.costObjectType;
    if (options.costObjectId !== undefined)
      this.costObjectId = options.costObjectId;
    if (options.category !== undefined) this.category = options.category;
    if (options.description !== undefined)
      this.description = options.description;
    if (options.amount !== undefined) this.amount = options.amount;
    if (options.currency !== undefined) this.currency = options.currency;
    if (options.incurredOn !== undefined) this.incurredOn = options.incurredOn;
    if (options.recordedAt !== undefined) this.recordedAt = options.recordedAt;
    if (options.recordedByProfileId !== undefined)
      this.recordedByProfileId = options.recordedByProfileId;
    if (options.paidBy !== undefined) this.paidBy = options.paidBy;
    if (options.paidByProfileId !== undefined)
      this.paidByProfileId = options.paidByProfileId;
    if (options.vendorId !== undefined) this.vendorId = options.vendorId;
    if (options.commitmentId !== undefined)
      this.commitmentId = options.commitmentId;
    if (options.commitmentLineId !== undefined)
      this.commitmentLineId = options.commitmentLineId;
    if (options.reimbursable !== undefined)
      this.reimbursable = options.reimbursable;
    if (options.reimbursedAt !== undefined)
      this.reimbursedAt = options.reimbursedAt;
    if (options.reimbursementReference !== undefined)
      this.reimbursementReference = options.reimbursementReference;
  }

  /** True when the person who paid has been paid back. */
  isReimbursed(): boolean {
    return this.reimbursedAt !== null && this.reimbursedAt !== undefined;
  }

  /** True when this expense counts toward reviewed totals and drawdown. */
  isCountable(): boolean {
    return this.reviewStatus === 'reviewed' && !this.duplicateOfId;
  }

  /**
   * Accept the expense as a real cost: `unreviewed → reviewed`.
   *
   * This is the separately authorizable review action: gate it in your route
   * or service (for example on `expenses.review`). The expense must already
   * be saved and must not be marked a duplicate.
   *
   * @throws {ExpenseError} `EXPENSE_REVIEW_TRANSITION` from any other state.
   */
  async review(input: ReviewExpenseInput): Promise<this> {
    const reviewer = requireReviewer(input?.reviewerProfileId);
    return this.transition('review', () => {
      this.reviewStatus = 'reviewed';
      this.reviewedByProfileId = reviewer;
      this.reviewedAt = input.at ?? new Date();
      this.reviewNote = input.note ?? '';
      this.duplicateOfId = null;
    });
  }

  /**
   * Refuse the expense: `unreviewed | reviewed → rejected`. A rejected
   * expense is kept and shown, and never counted.
   *
   * @throws {ExpenseError} `EXPENSE_REVIEW_TRANSITION` from `rejected`, or
   *   `EXPENSE_INVALID` without a reason.
   */
  async reject(input: RejectExpenseInput): Promise<this> {
    const reviewer = requireReviewer(input?.reviewerProfileId);
    const reason = (input.reason ?? '').trim();
    if (!reason) {
      throw new ExpenseError('EXPENSE_INVALID', 'A rejection needs a reason.');
    }
    return this.transition('reject', () => {
      this.reviewStatus = 'rejected';
      this.reviewedByProfileId = reviewer;
      this.reviewedAt = input.at ?? new Date();
      this.reviewNote = reason;
      this.duplicateOfId = null;
    });
  }

  /**
   * Mark this expense a duplicate of another expense in the same tenant:
   * `unreviewed | reviewed → rejected` with {@link Expense.duplicateOfId}
   * set. A duplicate never counts toward any total.
   *
   * @throws {ExpenseError} `EXPENSE_INVALID` when the target is this expense
   *   or is not visible in this expense's tenant.
   */
  async markDuplicate(input: MarkDuplicateExpenseInput): Promise<this> {
    const reviewer = requireReviewer(input?.reviewerProfileId);
    const targetId = String(input.duplicateOfId ?? '').trim();
    if (!targetId || targetId === this.id) {
      throw new ExpenseError(
        'EXPENSE_INVALID',
        'An expense can only be a duplicate of a different expense.',
      );
    }
    const { ExpenseCollection } = await import(
      '../collections/ExpenseCollection.js'
    );
    const expenses = await ExpenseCollection.create({ db: this.db });
    const target = await expenses.get({ id: targetId });
    if (!target || (target.tenantId ?? null) !== (this.tenantId ?? null)) {
      throw new ExpenseError(
        'EXPENSE_INVALID',
        `Expense ${targetId} was not found in this expense's tenant.`,
      );
    }
    return this.transition('markDuplicate', () => {
      this.reviewStatus = 'rejected';
      this.reviewedByProfileId = reviewer;
      this.reviewedAt = input.at ?? new Date();
      this.reviewNote = `Duplicate of expense ${targetId}`;
      this.duplicateOfId = targetId;
    });
  }

  /**
   * Send the expense back for review: `reviewed | rejected → unreviewed`.
   * Clears the reviewer, the review time and any duplicate marker.
   *
   * @throws {ExpenseError} `EXPENSE_REVIEW_TRANSITION` from `unreviewed`.
   */
  async reopen(input: ReopenExpenseInput): Promise<this> {
    requireReviewer(input?.reviewerProfileId);
    return this.transition('reopen', () => {
      this.reviewStatus = 'unreviewed';
      this.reviewedByProfileId = null;
      this.reviewedAt = null;
      this.reviewNote = input.note ?? '';
      this.duplicateOfId = null;
    });
  }

  /**
   * Record that the person who paid has been paid back. Recording only:
   * paying happens in payroll or payables, and this never changes the review
   * state.
   *
   * @throws {ExpenseError} `EXPENSE_INVALID` unless the expense is
   *   `reimbursable`.
   */
  async markReimbursed(input: MarkReimbursedInput = {}): Promise<this> {
    if (!this.reimbursable) {
      throw new ExpenseError(
        'EXPENSE_INVALID',
        `Expense ${this.id} is not owed back to anyone.`,
      );
    }
    this.reimbursedAt = input.at ?? new Date();
    if (input.reference !== undefined)
      this.reimbursementReference = input.reference;
    return this.save();
  }

  /**
   * Load the cost object this expense is charged to, through its registered
   * collection (so tenant interceptors apply). Returns `null` when unset,
   * when the type is not registered, when the row is gone, or when the row
   * belongs to a different tenant than this expense.
   */
  async getCostObject<T extends SmrtObject = SmrtObject>(): Promise<T | null> {
    if (!this.costObjectType || !this.costObjectId) return null;
    let registered = ObjectRegistry.getClassByQualifiedName(
      this.costObjectType,
    );
    if (!registered) {
      const loaded = await ObjectRegistry.tryLoadFromExternalPackage(
        this.costObjectType,
      );
      if (!loaded) return null;
      registered = ObjectRegistry.getClassByQualifiedName(this.costObjectType);
    }
    if (!registered) return null;
    const collection = await ObjectRegistry.getCollection<SmrtObject>(
      registered.qualifiedName ?? this.costObjectType,
      { db: this.db },
    );
    const target = await collection.get({ id: this.costObjectId });
    if (!target) return null;
    const targetTenant = (target as unknown as { tenantId?: string | null })
      .tenantId;
    if (
      targetTenant !== undefined &&
      targetTenant !== null &&
      this.tenantId !== null &&
      targetTenant !== this.tenantId
    ) {
      return null;
    }
    return target as T;
  }

  /**
   * Validate, enforce the review and reviewed-field locks, check the
   * commitment, then persist.
   */
  override async save(): Promise<this> {
    this.normalize();
    this.validateShape();

    const persisted = await this.readPersisted();
    // The guards below check `persisted`; pin the write to that row.
    const inserting = await pinNaturalKey('Expense', this, persisted);
    if (
      persisted &&
      String(persisted.tenant_id ?? '') !==
        String(effectiveTenant(this.tenantId) ?? '')
    ) {
      // Includes the quiet case: saving a global expense inside a tenant
      // context, where the interceptor would fill in that tenant and split
      // the expense from its global receipts and links.
      throw new ExpenseError(
        'EXPENSE_INVALID',
        `Expense ${this.id}: its tenant cannot change after it is recorded.`,
      );
    }
    this.assertReviewFields(persisted);
    this.assertReviewedLock(persisted);
    await this.assertCommitment(persisted);
    await this.assertVendor(persisted);

    if (!this.recordedAt) this.recordedAt = new Date();
    try {
      return await super.save();
    } catch (error) {
      // A new expense is a plain INSERT; its only unique keys are the id and
      // the natural key, so a violation means it named an existing row.
      if (inserting && isUniqueViolationError(error)) {
        throw identityConflict('Expense', this, error);
      }
      throw error;
    }
  }

  private normalize(): void {
    this.tenantId = normalizeTenantId(this.tenantId);
    this.currency = String(this.currency ?? '')
      .trim()
      .toUpperCase();
    this.category = String(this.category ?? '').trim();
    this.costObjectType = String(this.costObjectType ?? '').trim();
    this.costObjectId = String(this.costObjectId ?? '').trim();
    this.incurredOn = String(this.incurredOn ?? '').trim();
    this.vendorId = asNullableString(this.vendorId);
    this.commitmentId = asNullableString(this.commitmentId);
    this.commitmentLineId = asNullableString(this.commitmentLineId);
    this.paidByProfileId = asNullableString(this.paidByProfileId);
    this.recordedByProfileId = asNullableString(this.recordedByProfileId);
  }

  private validateShape(): void {
    const label = this.id || '<new>';
    assertMinorUnits('Expense', label, 'amount', this.amount);
    assertIsoCurrency('Expense', label, this.currency);
    assertIsoDate('Expense', label, 'incurredOn', this.incurredOn);
    if (!CATEGORY_PATTERN.test(this.category) || this.category.length > 64) {
      throw new ExpenseError(
        'EXPENSE_INVALID',
        `Expense ${label}: category must be lowercase kebab-case ` +
          `(for example 'outside-service'), got '${this.category}'.`,
      );
    }
    if (Boolean(this.costObjectType) !== Boolean(this.costObjectId)) {
      throw new ExpenseError(
        'EXPENSE_INVALID',
        `Expense ${label}: costObjectType and costObjectId are set together ` +
          'or not at all.',
      );
    }
    if (this.costObjectType) {
      assertQualifiedClassName('Expense', label, this.costObjectType);
    }
    if (this.paidBy !== 'company' && this.paidBy !== 'person') {
      throw new ExpenseError(
        'EXPENSE_INVALID',
        `Expense ${label}: paidBy must be 'company' or 'person'.`,
      );
    }
    if (this.paidBy === 'person' && !this.paidByProfileId) {
      throw new ExpenseError(
        'EXPENSE_INVALID',
        `Expense ${label}: an expense paid by a person names that person ` +
          '(paidByProfileId).',
      );
    }
    if (this.paidBy === 'company' && this.paidByProfileId) {
      throw new ExpenseError(
        'EXPENSE_INVALID',
        `Expense ${label}: paidByProfileId is only set when paidBy is 'person'.`,
      );
    }
    if (this.reimbursable && this.paidBy !== 'person') {
      throw new ExpenseError(
        'EXPENSE_INVALID',
        `Expense ${label}: only an expense a person paid can be owed back.`,
      );
    }
    if (this.reimbursedAt && !this.reimbursable) {
      throw new ExpenseError(
        'EXPENSE_INVALID',
        `Expense ${label}: reimbursedAt needs reimbursable.`,
      );
    }
    if (this.reviewStatus === 'reviewed' && this.duplicateOfId) {
      throw new ExpenseError(
        'EXPENSE_INVALID',
        `Expense ${label}: a reviewed expense cannot be marked a duplicate.`,
      );
    }
    if (this.commitmentLineId && !this.commitmentId) {
      throw new ExpenseError(
        'EXPENSE_INVALID',
        `Expense ${label}: a commitment line needs its commitment ` +
          '(commitmentId).',
      );
    }
  }

  /**
   * Read the stored row directly. The authoritative prior state for the
   * review and lock guards: the in-memory copy may have been mass-assigned.
   */
  private async readPersisted(): Promise<PersistedRow | null> {
    if (!this.id) return null;
    const row = await this.db.get(this.tableName, { id: this.id });
    return (row as PersistedRow | null | undefined) ?? null;
  }

  private reviewState(): ReviewFieldState {
    return {
      status: this.reviewStatus,
      reviewer: asNullableString(this.reviewedByProfileId),
      reviewedAtMs: instantMs(this.reviewedAt),
      note: this.reviewNote ?? '',
      duplicateOf: asNullableString(this.duplicateOfId),
    };
  }

  /**
   * Refuse any review-field change a transition did not authorize. The token
   * binds the transition's complete resulting state — status, reviewer,
   * time, note and duplicate marker — so a field set directly beside a
   * legitimate `review()` / `reject()` cannot ride along with it.
   */
  private assertReviewFields(persisted: PersistedRow | null): void {
    const token = authorizedTransition.get(this);
    const prior: ReviewFieldState = {
      status: (persisted?.review_status ?? 'unreviewed') as ExpenseReviewStatus,
      reviewer: asNullableString(persisted?.reviewed_by_profile_id),
      reviewedAtMs: instantMs(persisted?.reviewed_at),
      note: String(persisted?.review_note ?? ''),
      duplicateOf: asNullableString(persisted?.duplicate_of_id),
    };
    const current = this.reviewState();
    if (sameReviewState(current, prior)) return;
    if (
      !token ||
      token.from !== prior.status ||
      !sameReviewState(current, token.expected)
    ) {
      throw new ExpenseError(
        'EXPENSE_REVIEW_FIELDS_LOCKED',
        `Expense ${this.id || '<new>'}: review state changes only through ` +
          'review(), reject(), markDuplicate() or reopen().',
      );
    }
  }

  private assertReviewedLock(persisted: PersistedRow | null): void {
    if (persisted?.review_status !== 'reviewed') return;
    const self = this as unknown as Record<string, unknown>;
    for (const [fieldName, column] of LOCKED_WHEN_REVIEWED) {
      const before = persisted[column];
      const after = self[fieldName];
      const same =
        fieldName === 'amount'
          ? Number(before) === Number(after)
          : fieldName === 'recordedAt'
            ? instantMs(before) === instantMs(after)
            : asNullableString(before) === asNullableString(after);
      if (!same) {
        throw new ExpenseError(
          'EXPENSE_REVIEW_FIELDS_LOCKED',
          `Expense ${this.id}: ${fieldName} of a reviewed expense cannot ` +
            'change; reopen() it first.',
        );
      }
    }
  }

  /**
   * A matched commitment must be visible in this expense's tenant, owned by
   * the same tenant, and in the same currency; a matched line must belong to
   * it. Mixed currencies are refused here rather than summed later.
   *
   * Checked when the match is made or changed, not on every save: a later
   * change to the commitment (its currency, or its deletion) must not stop
   * an unrelated save such as recording a reimbursement.
   */
  private async assertCommitment(
    persisted: PersistedRow | null,
  ): Promise<void> {
    if (!this.commitmentId) return;
    if (
      persisted &&
      asNullableString(persisted.commitment_id) === this.commitmentId &&
      asNullableString(persisted.commitment_line_id) ===
        this.commitmentLineId &&
      String(persisted.currency ?? '') === this.currency
    ) {
      return;
    }
    const contracts = await ContractCollection.create({ db: this.db });
    const commitment = await contracts.get({ id: this.commitmentId });
    // Before super.save() the tenant interceptor has not populated tenantId
    // yet, so compare against the tenant the row is about to be written in.
    const owner = effectiveTenant(this.tenantId);
    if (!commitment || !sameTenant(commitment.tenantId, owner)) {
      throw new ExpenseError(
        'EXPENSE_COMMITMENT_MISMATCH',
        `Expense ${this.id || '<new>'}: commitment ${this.commitmentId} was ` +
          "not found in this expense's tenant.",
      );
    }
    if (String(commitment.currency).toUpperCase() !== this.currency) {
      throw new ExpenseError(
        'EXPENSE_COMMITMENT_MISMATCH',
        `Expense ${this.id || '<new>'}: currency ${this.currency} does not ` +
          `match commitment ${this.commitmentId} (${commitment.currency}). ` +
          'Amounts in different currencies are never summed.',
      );
    }
    if (this.commitmentLineId) {
      const lines = await ContractLineItemCollection.create({ db: this.db });
      const line = await lines.get({ id: this.commitmentLineId });
      if (!line || line.contractId !== this.commitmentId) {
        throw new ExpenseError(
          'EXPENSE_COMMITMENT_MISMATCH',
          `Expense ${this.id || '<new>'}: line ${this.commitmentLineId} is ` +
            `not a line of commitment ${this.commitmentId}.`,
        );
      }
    }
  }

  /**
   * A vendor must be visible in, and owned by, the expense's tenant. A
   * `crossPackageRef` neither validates its target nor creates a foreign
   * key, so without this an expense in one tenant could name another
   * tenant's vendor. Checked when the vendor is set or changed.
   */
  private async assertVendor(persisted: PersistedRow | null): Promise<void> {
    if (!this.vendorId) return;
    if (persisted && asNullableString(persisted.vendor_id) === this.vendorId) {
      return;
    }
    const vendors = await VendorCollection.create({ db: this.db });
    const vendor = await vendors.get({ id: this.vendorId });
    const owner = effectiveTenant(this.tenantId);
    if (!vendor || !sameTenant(vendor.tenantId, owner)) {
      throw new ExpenseError(
        'EXPENSE_VENDOR_MISMATCH',
        `Expense ${this.id || '<new>'}: vendor ${this.vendorId} was not ` +
          "found in this expense's tenant.",
      );
    }
  }

  private async transition(
    action: keyof typeof REVIEW_TRANSITIONS,
    apply: () => void,
  ): Promise<this> {
    const rule = REVIEW_TRANSITIONS[action];
    const persisted = await this.readPersisted();
    if (!persisted) {
      throw new ExpenseError(
        'EXPENSE_REVIEW_TRANSITION',
        `Expense ${this.id || '<new>'}: save the expense before ${action}().`,
      );
    }
    const from = String(persisted.review_status) as ExpenseReviewStatus;
    if (!rule.from.includes(from)) {
      throw new ExpenseError(
        'EXPENSE_REVIEW_TRANSITION',
        `Expense ${this.id}: cannot ${action}() an expense that is ${from}.`,
      );
    }
    if (action === 'review' && persisted.duplicate_of_id) {
      throw new ExpenseError(
        'EXPENSE_REVIEW_TRANSITION',
        `Expense ${this.id}: a duplicate cannot be reviewed; reopen() it first.`,
      );
    }
    const snapshot = {
      reviewStatus: this.reviewStatus,
      reviewedByProfileId: this.reviewedByProfileId,
      reviewedAt: this.reviewedAt,
      reviewNote: this.reviewNote,
      duplicateOfId: this.duplicateOfId,
    };
    // Every transition assigns every review field, so the token below
    // describes the whole resulting review state.
    apply();
    authorizedTransition.set(this, { from, expected: this.reviewState() });
    try {
      return await this.save();
    } catch (error) {
      Object.assign(this, snapshot);
      throw error;
    } finally {
      authorizedTransition.delete(this);
    }
  }
}

function requireReviewer(reviewerProfileId: string | undefined): string {
  const reviewer = String(reviewerProfileId ?? '').trim();
  if (!reviewer) {
    throw new ExpenseError(
      'EXPENSE_INVALID',
      'A review decision names its reviewer (reviewerProfileId).',
    );
  }
  return reviewer;
}

function sameTenant(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  return (a ?? null) === (b ?? null);
}
