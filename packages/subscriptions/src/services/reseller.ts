/**
 * Reseller price books and parent-delegated spending (#3059).
 *
 * Billing ownership comes from the released smrt-tenancy
 * `BillingRelationshipService`; this service never re-derives it. Rating lives
 * on `CommercialUsageService.rateUsage()`, enforcement on
 * `SpendingPolicyEvaluator` — this service manages the records they read.
 */
import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import {
  type BillingRelationshipView,
  getTenantId,
  isSuperAdminBypass,
  isSystemContext,
  TenantIsolationError,
} from '@happyvertical/smrt-tenancy';
import {
  BillingAdjustmentCollection,
  ClientChargeCollection,
  type PricingRule,
  PricingRuleCollection,
  type PricingStrategy,
  type SpendingBasis,
  type SpendingPeriod,
  type SpendingPolicy,
  type SpendingPolicyBehavior,
  SpendingPolicyCollection,
} from '../models/commercial.js';
import {
  type CreditGrant,
  CreditGrantCollection,
  isCurrencyCode,
  type PriceBook,
  type PriceBookAssignment,
  PriceBookAssignmentCollection,
  PriceBookCollection,
  type PriceBookKind,
  RetailChargeCollection,
} from '../models/reseller.js';
import type { SubscriberKind } from '../types.js';
import { deterministicUuid, tenantKey } from '../utils.js';
import {
  type BillingRelationshipReader,
  SpendingPolicyEvaluator,
} from './commercial.js';
import { ResellerBillingError } from './reseller-errors.js';

export type ResellerBillingAction =
  | 'define_prices'
  | 'assign_price_books'
  | 'manage_child_spending';

export interface ResellerBillingServiceOptions extends SmrtClassOptions {
  /** The released smrt-tenancy billing relationship reader. */
  billingRelationships: BillingRelationshipReader;
  /**
   * Optional host permission check. Without it, only a system context or a
   * super-admin bypass may mutate reseller billing records, mirroring
   * `BillingRelationshipService`.
   */
  authorize?: (request: {
    action: ResellerBillingAction;
    /** The seller (price definitions) or parent (assignments, spending). */
    tenantId: string;
    childTenantId?: string;
    /** For `assign_price_books`: which legs the call changes. */
    kinds?: PriceBookKind[];
  }) => Promise<boolean>;
}

export interface DefinePriceBookPriceInput {
  priceBookId: string;
  ruleKey: string;
  metricKey: string;
  serviceKey?: string;
  strategy: PricingStrategy;
  effectiveFrom?: Date;
  effectiveTo?: Date | null;
  priority?: number;
  /**
   * One entry per currency. Terms use the same *minor units per unit of usage*
   * convention as any `PricingRule` (#2401).
   */
  prices: Array<{ currency: string; terms: Record<string, unknown> }>;
}

export interface PriceBookLeg {
  priceBookId: string;
  /** Currency the leg is charged in; the book needs a price in it. */
  currency: string;
}

export interface AssignPriceBooksInput {
  childTenantId: string;
  /** `undefined` keeps the current leg; `null` clears it. */
  wholesale?: PriceBookLeg | null;
  retail?: PriceBookLeg | null;
}

export interface PriceBookAssignmentView {
  childTenantId: string;
  resellerTenantId: string;
  wholesale: PriceBookLeg | null;
  retail: PriceBookLeg | null;
}

export interface DelegatedSpendingPolicyInput {
  parentTenantId: string;
  childTenantId: string;
  name: string;
  basis: SpendingBasis;
  currency: string;
  behavior: SpendingPolicyBehavior;
  period?: SpendingPeriod;
  rollingSeconds?: number;
  /** Integer minor units; must be 0 (the default) for a `balance` policy. */
  limitAmount?: number;
  metricKey?: string;
  serviceKey?: string;
  projectId?: string;
  subscriberKind?: SubscriberKind | '';
  subscriberExternalId?: string;
  priority?: number;
  active?: boolean;
  balanceFrom?: Date;
}

export interface GrantChildCreditInput {
  parentTenantId: string;
  childTenantId: string;
  spendingPolicyId: string;
  /** Signed, nonzero integer minor units of the policy currency. */
  amount: number;
  reason?: string;
  source?: string;
  sourceId?: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function canonicalTenantId(id: string): string {
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
    throw new ResellerBillingError(
      'Tenant IDs must be UUIDs.',
      'INVALID_TENANT',
    );
  }
  return id.toLowerCase();
}

function assertCurrency(currency: string): void {
  if (!isCurrencyCode(currency)) {
    throw new ResellerBillingError(
      `Currency '${currency}' must be a three-letter upper-case code.`,
      'INVALID_CURRENCY',
    );
  }
}

function legView(
  priceBookId: string | null | undefined,
  currency: string,
): PriceBookLeg | null {
  return priceBookId ? { priceBookId: String(priceBookId), currency } : null;
}

function assignmentView(row: PriceBookAssignment): PriceBookAssignmentView {
  return {
    childTenantId: tenantKey(row.childTenantId),
    resellerTenantId: tenantKey(row.resellerTenantId),
    wholesale: legView(row.wholesalePriceBookId, row.wholesaleCurrency),
    retail: legView(row.retailPriceBookId, row.retailCurrency),
  };
}

/**
 * Manages price books, their per-relationship assignment, and the spending
 * policies and credits a parent tenant sets on its children.
 */
export class ResellerBillingService {
  private constructor(
    private readonly options: ResellerBillingServiceOptions,
    private readonly books: PriceBookCollection,
    private readonly assignments: PriceBookAssignmentCollection,
    private readonly rules: PricingRuleCollection,
    private readonly policies: SpendingPolicyCollection,
    private readonly evaluator: SpendingPolicyEvaluator,
  ) {}

  static async create(
    options: ResellerBillingServiceOptions,
  ): Promise<ResellerBillingService> {
    if (typeof options.billingRelationships?.getRelationship !== 'function') {
      throw new Error(
        'Reseller billing requires a billingRelationships reader from smrt-tenancy.',
      );
    }
    const {
      billingRelationships: _reader,
      authorize: _authorize,
      ...rest
    } = options;
    const books = await PriceBookCollection.create(rest);
    const shared = { ...rest, db: books.db };
    const policies = await SpendingPolicyCollection.create(shared);
    const evaluator = new SpendingPolicyEvaluator(
      policies,
      await ClientChargeCollection.create(shared),
      await BillingAdjustmentCollection.create(shared),
      {
        retailCharges: await RetailChargeCollection.create(shared),
        credits: await CreditGrantCollection.create(shared),
      },
    );
    return new ResellerBillingService(
      options,
      books,
      await PriceBookAssignmentCollection.create(shared),
      await PricingRuleCollection.create(shared),
      policies,
      evaluator,
    );
  }

  /**
   * Publish one price in a book, in one or more currencies. Each currency is
   * a `PricingRule` owned by the book's seller; re-defining the same rule key,
   * currency, and effective date replaces that rule's terms.
   */
  async definePrice(input: DefinePriceBookPriceInput): Promise<PricingRule[]> {
    const book = await this.requireBook(input.priceBookId);
    const sellerTenantId = canonicalTenantId(String(book.tenantId));
    await this.assertManage('define_prices', sellerTenantId, undefined, true);
    if (!input.ruleKey.trim() || !input.metricKey.trim()) {
      throw new Error('Price book prices require a ruleKey and metricKey.');
    }
    if (input.prices.length === 0) {
      throw new ResellerBillingError(
        'A price needs at least one currency.',
        'INVALID_CURRENCY',
      );
    }
    const currencies = new Set<string>();
    for (const { currency } of input.prices) {
      assertCurrency(currency);
      if (currencies.has(currency)) {
        throw new ResellerBillingError(
          `Currency ${currency} is listed twice for one price.`,
          'INVALID_CURRENCY',
        );
      }
      currencies.add(currency);
    }
    const effectiveFrom = input.effectiveFrom ?? new Date();
    const saved: PricingRule[] = [];
    for (const { currency, terms } of input.prices) {
      const id = await deterministicUuid([
        'price-book-rule',
        String(book.id),
        input.ruleKey,
        currency,
        effectiveFrom.toISOString(),
      ]);
      const values = {
        tenantId: book.tenantId,
        priceBookId: String(book.id),
        ruleKey: input.ruleKey,
        metricKey: input.metricKey,
        serviceKey: input.serviceKey ?? '',
        strategy: input.strategy,
        currency,
        effectiveFrom,
        effectiveTo: input.effectiveTo ?? null,
        priority: input.priority ?? 0,
        terms: JSON.stringify(terms),
        active: true,
      };
      const existing = await this.rules.get(id);
      if (existing) {
        Object.assign(existing, values);
        await existing.save();
        saved.push(existing);
      } else {
        saved.push(await this.rules.create({ id, ...values }));
      }
    }
    return saved;
  }

  /**
   * Select the wholesale and/or retail book that rates a child's usage under
   * its current reseller relationship. The retail book must be published by
   * that reseller.
   */
  async assignPriceBooks(
    input: AssignPriceBooksInput,
  ): Promise<PriceBookAssignmentView> {
    const relationship = await this.requireRelationship(input.childTenantId);
    const kinds: PriceBookKind[] = [];
    if (input.wholesale !== undefined) kinds.push('wholesale');
    if (input.retail !== undefined) kinds.push('retail');
    await this.assertManage(
      'assign_price_books',
      relationship.resellerTenantId,
      relationship.childTenantId,
      false,
      kinds,
    );
    if (input.wholesale) {
      await this.requireLeg(input.wholesale, 'wholesale');
    }
    if (input.retail) {
      const book = await this.requireLeg(input.retail, 'retail');
      if (tenantKey(book.tenantId) !== relationship.resellerTenantId) {
        throw new ResellerBillingError(
          `Retail price book '${book.bookKey}' is not published by the child's reseller.`,
          'PRICE_BOOK_OWNER_MISMATCH',
        );
      }
    }
    const existing = await this.assignments.get({
      childTenantId: relationship.childTenantId,
    });
    // An assignment made under a previous reseller does not carry over.
    const current =
      existing &&
      tenantKey(existing.resellerTenantId) === relationship.resellerTenantId
        ? assignmentView(existing)
        : null;
    const wholesale =
      input.wholesale === undefined
        ? (current?.wholesale ?? null)
        : input.wholesale;
    const retail =
      input.retail === undefined ? (current?.retail ?? null) : input.retail;
    const values = {
      childTenantId: relationship.childTenantId,
      resellerTenantId: relationship.resellerTenantId,
      wholesalePriceBookId: wholesale?.priceBookId ?? '',
      wholesaleCurrency: wholesale?.currency ?? '',
      retailPriceBookId: retail?.priceBookId ?? '',
      retailCurrency: retail?.currency ?? '',
    };
    if (existing) {
      Object.assign(existing, values);
      await existing.save();
      return assignmentView(existing);
    }
    return assignmentView(await this.assignments.create(values));
  }

  /** The child's assignment under its current reseller, if any. */
  async getPriceBookAssignment(
    childTenantId: string,
  ): Promise<PriceBookAssignmentView | null> {
    const relationship =
      await this.options.billingRelationships.getRelationship(
        canonicalTenantId(childTenantId),
      );
    if (!relationship) return null;
    const row = await this.assignments.get({
      childTenantId: relationship.childTenantId,
    });
    if (
      !row ||
      tenantKey(row.resellerTenantId) !== relationship.resellerTenantId
    ) {
      return null;
    }
    return assignmentView(row);
  }

  /**
   * Create or replace a spending policy that a parent sets on its child. The
   * row belongs to the child (so the ordinary evaluator enforces it for the
   * child) and records the parent in `setByTenantId`, which locks it against
   * changes by the child. Use `period: 'balance'` for a prepaid credit
   * balance and fund it with {@link grantChildCredit}.
   */
  async setDelegatedSpendingPolicy(
    input: DelegatedSpendingPolicyInput,
  ): Promise<SpendingPolicy> {
    const parentTenantId = canonicalTenantId(input.parentTenantId);
    const relationship = await this.requireChildOf(
      input.childTenantId,
      parentTenantId,
    );
    await this.assertManage(
      'manage_child_spending',
      parentTenantId,
      relationship.childTenantId,
    );
    assertCurrency(input.currency);
    if (
      input.limitAmount !== undefined &&
      !Number.isSafeInteger(input.limitAmount)
    ) {
      throw new ResellerBillingError(
        `Spending limits must be integer minor units — got ${input.limitAmount}.`,
        'INVALID_AMOUNT',
      );
    }
    const values = {
      tenantId: relationship.childTenantId,
      name: input.name,
      subscriberKind: input.subscriberKind ?? '',
      subscriberExternalId: input.subscriberExternalId ?? '',
      projectId: input.projectId ?? '',
      serviceKey: input.serviceKey ?? '',
      metricKey: input.metricKey ?? '',
      period: input.period ?? 'month',
      rollingSeconds: input.rollingSeconds ?? 0,
      limitAmount: input.limitAmount ?? 0,
      currency: input.currency,
      behavior: input.behavior,
      priority: input.priority ?? 0,
      active: input.active ?? true,
      basis: input.basis,
      setByTenantId: parentTenantId,
      ...(input.balanceFrom ? { balanceFrom: input.balanceFrom } : {}),
    };
    const existing = (
      await this.policies.list({
        where: {
          tenantId: values.tenantId,
          subscriberKind: values.subscriberKind,
          subscriberExternalId: values.subscriberExternalId,
          projectId: values.projectId,
          serviceKey: values.serviceKey,
          metricKey: values.metricKey,
          period: values.period,
          name: values.name,
        },
        limit: 1,
      })
    )[0];
    if (existing) {
      if (tenantKey(existing.setByTenantId) !== parentTenantId) {
        throw new ResellerBillingError(
          `Spending policy '${input.name}' already exists for this child and was not set by this parent.`,
          'POLICY_CONFLICT',
        );
      }
      Object.assign(existing, values);
      await existing.save();
      return existing;
    }
    return this.policies.create(values);
  }

  /** Credit a prepaid balance policy the parent set on its child. */
  async grantChildCredit(input: GrantChildCreditInput): Promise<CreditGrant> {
    const parentTenantId = canonicalTenantId(input.parentTenantId);
    const relationship = await this.requireChildOf(
      input.childTenantId,
      parentTenantId,
    );
    await this.assertManage(
      'manage_child_spending',
      parentTenantId,
      relationship.childTenantId,
    );
    const policy = await this.policies.get(input.spendingPolicyId);
    if (
      !policy ||
      tenantKey(policy.tenantId) !== relationship.childTenantId ||
      tenantKey(policy.setByTenantId) !== parentTenantId
    ) {
      throw new ResellerBillingError(
        `Spending policy ${input.spendingPolicyId} is not a policy this parent set on the child.`,
        'POLICY_NOT_FOUND',
      );
    }
    return this.evaluator.grantCredit({
      spendingPolicyId: input.spendingPolicyId,
      amount: input.amount,
      reason: input.reason,
      source: input.source,
      sourceId: input.sourceId,
      grantedByTenantId: parentTenantId,
    });
  }

  private async requireRelationship(
    childTenantId: string,
  ): Promise<BillingRelationshipView> {
    const relationship =
      await this.options.billingRelationships.getRelationship(
        canonicalTenantId(childTenantId),
      );
    if (!relationship) {
      throw new ResellerBillingError(
        `Tenant ${childTenantId} has no reseller relationship.`,
        'RELATIONSHIP_REQUIRED',
      );
    }
    return relationship;
  }

  private async requireChildOf(
    childTenantId: string,
    parentTenantId: string,
  ): Promise<BillingRelationshipView> {
    const relationship = await this.requireRelationship(childTenantId);
    if (relationship.resellerTenantId !== parentTenantId) {
      throw new ResellerBillingError(
        `Tenant ${childTenantId} is not a child of ${parentTenantId}.`,
        'RELATIONSHIP_REQUIRED',
      );
    }
    return relationship;
  }

  private async requireBook(id: string): Promise<PriceBook> {
    const book = await this.books.get(id);
    if (!book?.id) {
      throw new ResellerBillingError(
        `Price book ${id} was not found.`,
        'PRICE_BOOK_NOT_FOUND',
      );
    }
    return book;
  }

  private async requireLeg(
    leg: PriceBookLeg,
    kind: PriceBookKind,
  ): Promise<PriceBook> {
    assertCurrency(leg.currency);
    const book = await this.requireBook(leg.priceBookId);
    if (book.kind !== kind) {
      throw new ResellerBillingError(
        `Price book '${book.bookKey}' is a ${book.kind} book, not ${kind}.`,
        'PRICE_BOOK_KIND_MISMATCH',
      );
    }
    return book;
  }

  private async assertManage(
    action: ResellerBillingAction,
    tenantId: string,
    childTenantId?: string,
    allowOwnTenant = false,
    kinds?: PriceBookKind[],
  ): Promise<void> {
    if (
      isSystemContext() ||
      isSuperAdminBypass() ||
      (allowOwnTenant && getTenantId()?.toLowerCase() === tenantId) ||
      (await this.options.authorize?.({
        action,
        tenantId,
        childTenantId,
        kinds,
      }))
    ) {
      return;
    }
    throw new TenantIsolationError('Reseller billing mutation denied.');
  }
}
