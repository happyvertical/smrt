/**
 * Billing-period close (#3060): approved charges and flat plan fees per
 * billing owner → commerce invoice → provider invoice (with provider tax) →
 * ledger.
 *
 * Replay safety comes from identity, not from a transaction spanning the
 * provider call:
 *
 * - each payer/currency/period has one {@link BillingPeriodClose} whose id is
 *   derived from that identity, and a lease so two workers never advance the
 *   same close at once;
 * - each billable source is claimed by one {@link BillingLineSource} whose id
 *   is derived from the source, so a charge is billed at most once however
 *   many periods or workers race for it;
 * - the invoice and its lines have ids derived from the close, and the
 *   provider invoice uses the close id as its idempotency key;
 * - every step persists its outcome before the next, so a retry resumes where
 *   the last attempt stopped.
 */
import type {
  ClientCharge,
  RetailCharge,
  SubscriptionPlan,
  TenantSubscription,
} from '@happyvertical/smrt-subscriptions';
import { withSystemContext, withTenant } from '@happyvertical/smrt-tenancy';
import type {
  BillingAccount,
  BillingLineSource,
  BillingLineSourceType,
  BillingPeriodClose,
} from '../models/billing.js';
import type { Invoice } from '../models/Invoice.js';
import { InvoiceStatus } from '../types/index.js';
import type { BillingProviderInvoiceLine } from './provider.js';
import type { BillingRuntime } from './runtime.js';
import { deterministicId, normalizeCurrency, tenantKey } from './units.js';

export interface BillingPeriod {
  /** Inclusive start. */
  periodStart: Date;
  /** Exclusive end; charges approved before it are billable. */
  periodEnd: Date;
}

export interface ClosePeriodInput {
  periodStart?: Date;
  periodEnd?: Date;
  /** Clock override for tests; defaults to now. */
  now?: Date;
}

export type PeriodCloseOutcome =
  | 'completed'
  | 'empty'
  | 'busy'
  | 'carried_forward'
  | 'failed';

export interface PeriodCloseGroupResult {
  payerTenantId: string;
  currency: string;
  closeId?: string;
  invoiceId?: string;
  providerInvoiceId?: string;
  outcome: PeriodCloseOutcome;
  error?: string;
}

export interface PeriodCloseResult extends BillingPeriod {
  sellerTenantId: string;
  groups: PeriodCloseGroupResult[];
}

/** Thrown when one or more payers could not be closed; the rest were. */
export class BillingPeriodCloseError extends Error {
  constructor(readonly result: PeriodCloseResult) {
    const failed = result.groups.filter((group) => group.outcome === 'failed');
    super(
      `Billing period close failed for ${failed.length} payer group(s): ${failed
        .map(
          (group) => `${group.payerTenantId}/${group.currency}: ${group.error}`,
        )
        .join('; ')}`,
    );
    this.name = 'BillingPeriodCloseError';
  }
}

interface Candidate {
  sourceType: BillingLineSourceType;
  sourceId: string;
  payerTenantId: string;
  currency: string;
  lineKey: string;
  lineDescription: string;
  amount: number;
  quantity: number;
  /** Flat-plan sources take the payer account's discount at claim time. */
  discountable: boolean;
  periodStart: Date | null;
  periodEnd: Date | null;
}

interface CandidateGroup {
  payerTenantId: string;
  currency: string;
  closeId: string;
  candidates: Candidate[];
}

/** The previous calendar month in UTC relative to `now`. */
export function previousCalendarMonth(now = new Date()): BillingPeriod {
  const periodEnd = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );
  const periodStart = new Date(
    Date.UTC(periodEnd.getUTCFullYear(), periodEnd.getUTCMonth() - 1, 1),
  );
  return { periodStart, periodEnd };
}

function isCalendarMonth(period: BillingPeriod): boolean {
  const { periodStart: start, periodEnd: end } = period;
  return (
    start.getUTCDate() === 1 &&
    start.getUTCHours() === 0 &&
    start.getUTCMinutes() === 0 &&
    start.getUTCSeconds() === 0 &&
    start.getUTCMilliseconds() === 0 &&
    end.getTime() ===
      Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)
  );
}

function resolvePeriod(input: ClosePeriodInput): BillingPeriod {
  if (!input.periodStart && !input.periodEnd) {
    return previousCalendarMonth(input.now);
  }
  if (!input.periodStart || !input.periodEnd) {
    throw new Error('Pass both periodStart and periodEnd, or neither.');
  }
  const period = { periodStart: input.periodStart, periodEnd: input.periodEnd };
  if (
    !Number.isFinite(period.periodStart.getTime()) ||
    !(period.periodEnd.getTime() > period.periodStart.getTime())
  ) {
    throw new Error('A billing period must end after it starts.');
  }
  const now = input.now ?? new Date();
  if (period.periodEnd.getTime() > now.getTime()) {
    throw new Error('A billing period cannot be closed before it ends.');
  }
  return period;
}

export function periodCloseId(
  runtime: Pick<BillingRuntime, 'sellerTenantId' | 'kind'>,
  payerTenantId: string,
  currency: string,
  period: BillingPeriod,
): Promise<string> {
  return deterministicId([
    'billing-period-close',
    runtime.sellerTenantId,
    runtime.kind,
    tenantKey(payerTenantId),
    normalizeCurrency(currency),
    period.periodStart.toISOString(),
    period.periodEnd.toISOString(),
  ]);
}

function sourceId(type: BillingLineSourceType, id: string): Promise<string> {
  return deterministicId(['billing-line-source', type, id]);
}

/**
 * Close one billing period for a runtime's seller. Idempotent: re-running it
 * for the same period resumes unfinished payers and bills nothing twice.
 */
export async function closeBillingPeriod(
  runtime: BillingRuntime,
  input: ClosePeriodInput = {},
): Promise<PeriodCloseResult> {
  const period = resolvePeriod(input);
  const now = input.now ?? new Date();
  const groups = await withSystemContext(() => collectGroups(runtime, period));
  // Closes of this period still in progress, including ones whose every
  // source was already claimed (a collection query no longer returns them).
  const existing = (
    await runtime.closes.list({
      where: {
        sellerTenantId: runtime.sellerTenantId,
        kind: runtime.kind,
        'status !=': 'completed',
      },
    })
  ).filter(
    (close) =>
      close.periodStart.getTime() === period.periodStart.getTime() &&
      close.periodEnd.getTime() === period.periodEnd.getTime(),
  );
  const results: PeriodCloseGroupResult[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    seen.add(group.closeId);
    results.push(await closeGroup(runtime, period, group, now));
  }
  // Resume closes whose sources were all claimed on an earlier attempt.
  for (const close of existing) {
    if (
      !close.id ||
      seen.has(close.id) ||
      close.status === 'completed' ||
      close.status === 'carried_forward'
    ) {
      continue;
    }
    results.push(
      await closeGroup(
        runtime,
        period,
        {
          payerTenantId: close.payerTenantId,
          currency: close.currency,
          closeId: close.id,
          candidates: [],
        },
        now,
      ),
    );
  }
  const result: PeriodCloseResult = {
    sellerTenantId: runtime.sellerTenantId,
    ...period,
    groups: results,
  };
  if (results.some((group) => group.outcome === 'failed')) {
    throw new BillingPeriodCloseError(result);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

async function collectGroups(
  runtime: BillingRuntime,
  period: BillingPeriod,
): Promise<CandidateGroup[]> {
  const candidates: Candidate[] = [];
  if (runtime.kind === 'provider') {
    candidates.push(...(await collectClientCharges(runtime, period)));
    candidates.push(...(await collectAdjustments(runtime, period)));
  } else {
    candidates.push(...(await collectRetailCharges(runtime, period)));
  }
  if (isCalendarMonth(period)) {
    candidates.push(...(await collectFlatPlans(runtime, period)));
  }
  candidates.push(...(await collectCarriedCredits(runtime, period)));

  const byGroup = new Map<string, CandidateGroup>();
  for (const candidate of candidates) {
    const key = `${candidate.payerTenantId}|${candidate.currency}`;
    let group = byGroup.get(key);
    if (!group) {
      group = {
        payerTenantId: candidate.payerTenantId,
        currency: candidate.currency,
        closeId: await periodCloseId(
          runtime,
          candidate.payerTenantId,
          candidate.currency,
          period,
        ),
        candidates: [],
      };
      byGroup.set(key, group);
    }
    group.candidates.push(candidate);
  }

  // Drop sources another close already claimed; keep this close's own claims
  // so a retry rebuilds the same invoice.
  const groups = [...byGroup.values()].sort((a, b) =>
    `${a.payerTenantId}|${a.currency}`.localeCompare(
      `${b.payerTenantId}|${b.currency}`,
    ),
  );
  for (const group of groups) {
    const ids = await Promise.all(
      group.candidates.map((candidate) =>
        sourceId(candidate.sourceType, candidate.sourceId),
      ),
    );
    const claimed = new Map<string, string>();
    for (let offset = 0; offset < ids.length; offset += runtime.pageSize) {
      const rows = await runtime.sources.list({
        where: { id: ids.slice(offset, offset + runtime.pageSize) },
      });
      for (const row of rows) {
        if (row.id) claimed.set(row.id, row.periodCloseId);
      }
    }
    group.candidates = group.candidates.filter((_, index) => {
      const owner = claimed.get(ids[index]);
      return owner === undefined || owner === group.closeId;
    });
  }
  // A carried credit alone is not new activity: it stays claimable at its
  // original close until the payer is next billed.
  return groups.filter((group) =>
    group.candidates.some(
      (candidate) => candidate.sourceType !== 'credit_carry_forward',
    ),
  );
}

async function listAll<T>(
  pageSize: number,
  page: (limit: number, offset: number) => Promise<T[]>,
): Promise<T[]> {
  const all: T[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const rows = await page(pageSize, offset);
    all.push(...rows);
    if (rows.length < pageSize) return all;
  }
}

/**
 * Ids of rows in `table` matching `where` that no close has claimed yet.
 * The anti-join keeps each run proportional to unbilled work rather than to
 * the whole charge history.
 */
async function unclaimedIds(
  runtime: BillingRuntime,
  table: string,
  sourceType: BillingLineSourceType,
  where: string,
  params: unknown[],
): Promise<string[]> {
  const ids: string[] = [];
  for (let offset = 0; ; offset += runtime.pageSize) {
    const result = await runtime.db.query(
      `SELECT c.id AS id FROM ${table} c
        LEFT JOIN _smrt_billing_line_sources s
          ON s.source_type = ? AND s.source_id = CAST(c.id AS TEXT)
       WHERE s.id IS NULL AND ${where}
       ORDER BY c.id
       LIMIT ? OFFSET ?`,
      sourceType,
      ...params,
      runtime.pageSize,
      offset,
    );
    for (const row of result.rows) ids.push(String(row.id));
    if (result.rows.length < runtime.pageSize) return ids;
  }
}

/** Load rows by id in pages through a collection. */
async function loadByIds<T>(
  pageSize: number,
  ids: string[],
  load: (batch: string[]) => Promise<T[]>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; offset < ids.length; offset += pageSize) {
    rows.push(...(await load(ids.slice(offset, offset + pageSize))));
  }
  return rows;
}

function usageDescription(
  metricKey: string,
  serviceKey: string,
  quantity: number,
  usageTenantId?: string,
): string {
  const service = serviceKey ? ` (${serviceKey})` : '';
  const tenant = usageTenantId ? ` for tenant ${usageTenantId}` : '';
  const units = Number.isFinite(quantity)
    ? ` — ${Number(quantity.toFixed(6))} units`
    : '';
  return `Usage: ${metricKey}${service}${tenant}${units}`;
}

/** Wholesale books this seller publishes; charges priced by others are not ours. */
async function sellerBookIds(runtime: BillingRuntime): Promise<Set<string>> {
  const books = await listAll(runtime.pageSize, (limit, offset) =>
    runtime.books.list({
      where: { tenantId: runtime.sellerTenantId },
      orderBy: 'id ASC',
      limit,
      offset,
    }),
  );
  return new Set(books.map((book) => String(book.id)));
}

function isSellerCharge(charge: ClientCharge, books: Set<string>): boolean {
  return !charge.priceBookId || books.has(String(charge.priceBookId));
}

async function collectClientCharges(
  runtime: BillingRuntime,
  period: BillingPeriod,
): Promise<Candidate[]> {
  const books = await sellerBookIds(runtime);
  const ids = await unclaimedIds(
    runtime,
    '_smrt_client_charges',
    'client_charge',
    "c.status IN ('approved', 'adjusted') AND c.approved_at < ?",
    [period.periodEnd.toISOString()],
  );
  const charges = await loadByIds(runtime.pageSize, ids, (batch) =>
    runtime.charges.list({ where: { id: batch } }),
  );
  return charges
    .filter((charge) => charge.id && isSellerCharge(charge, books))
    .filter((charge) => tenantKey(charge.tenantId) !== runtime.sellerTenantId)
    .map((charge) => {
      const payer = tenantKey(charge.tenantId);
      const usageTenant = tenantKey(charge.usageTenantId);
      const child = usageTenant && usageTenant !== payer ? usageTenant : '';
      return {
        sourceType: 'client_charge' as const,
        sourceId: String(charge.id),
        payerTenantId: payer,
        currency: normalizeCurrency(charge.currency),
        lineKey: `usage|${charge.serviceKey}|${charge.metricKey}|${child}`,
        lineDescription: usageDescription(
          charge.metricKey,
          charge.serviceKey,
          Number(charge.quantity) || 0,
          child,
        ),
        amount: Number(charge.amount),
        quantity: Number(charge.quantity) || 0,
        discountable: false,
        periodStart: null,
        periodEnd: null,
      };
    });
}

async function collectAdjustments(
  runtime: BillingRuntime,
  period: BillingPeriod,
): Promise<Candidate[]> {
  const books = await sellerBookIds(runtime);
  const ids = await unclaimedIds(
    runtime,
    '_smrt_billing_adjustments',
    'billing_adjustment',
    'c.created_at < ?',
    [period.periodEnd.toISOString()],
  );
  const adjustments = await loadByIds(runtime.pageSize, ids, (batch) =>
    runtime.adjustments.list({ where: { id: batch } }),
  );
  const chargeIds = [
    ...new Set(adjustments.map((row) => String(row.clientChargeId))),
  ].filter(Boolean);
  const charges = new Map<string, ClientCharge>();
  for (let offset = 0; offset < chargeIds.length; offset += runtime.pageSize) {
    const rows = await runtime.charges.list({
      where: { id: chargeIds.slice(offset, offset + runtime.pageSize) },
    });
    for (const row of rows) charges.set(String(row.id), row);
  }
  const candidates: Candidate[] = [];
  for (const adjustment of adjustments) {
    const charge = charges.get(String(adjustment.clientChargeId));
    if (
      !adjustment.id ||
      !charge ||
      !isSellerCharge(charge, books) ||
      (charge.status !== 'approved' && charge.status !== 'adjusted')
    ) {
      continue;
    }
    const payer = tenantKey(adjustment.tenantId);
    if (!payer || payer === runtime.sellerTenantId) continue;
    candidates.push({
      sourceType: 'billing_adjustment',
      sourceId: String(adjustment.id),
      payerTenantId: payer,
      currency: normalizeCurrency(adjustment.currency),
      lineKey: 'adjustment',
      lineDescription: 'Billing adjustments',
      amount: Number(adjustment.amount),
      quantity: 0,
      discountable: false,
      periodStart: null,
      periodEnd: null,
    });
  }
  return candidates;
}

async function collectRetailCharges(
  runtime: BillingRuntime,
  period: BillingPeriod,
): Promise<Candidate[]> {
  const ids = await unclaimedIds(
    runtime,
    '_smrt_retail_charges',
    'retail_charge',
    "c.reseller_tenant_id = ? AND c.status = 'approved' AND c.approved_at < ?",
    [runtime.sellerTenantId, period.periodEnd.toISOString()],
  );
  const charges = await loadByIds(runtime.pageSize, ids, (batch) =>
    runtime.retailCharges.list({ where: { id: batch } }),
  );
  return charges
    .filter((charge: RetailCharge) => charge.id)
    .map((charge: RetailCharge) => ({
      sourceType: 'retail_charge' as const,
      sourceId: String(charge.id),
      payerTenantId: tenantKey(charge.tenantId),
      currency: normalizeCurrency(charge.currency),
      lineKey: `retail|${charge.serviceKey}|${charge.metricKey}`,
      lineDescription: usageDescription(
        charge.metricKey,
        charge.serviceKey,
        Number(charge.quantity) || 0,
      ),
      amount: Number(charge.amount),
      quantity: Number(charge.quantity) || 0,
      discountable: false,
      periodStart: null,
      periodEnd: null,
    }));
}

/** Net credits carried forward by this seller's earlier closes. */
async function collectCarriedCredits(
  runtime: BillingRuntime,
  period: BillingPeriod,
): Promise<Candidate[]> {
  // Only unconsumed credits: a close is marked completed once a later close
  // claims its credit, so this scan stays proportional to open credits.
  const carried = await listAll(runtime.pageSize, (limit, offset) =>
    runtime.closes.list({
      where: {
        sellerTenantId: runtime.sellerTenantId,
        kind: runtime.kind,
        status: 'carried_forward',
      },
      orderBy: 'id ASC',
      limit,
      offset,
    }),
  );
  return carried
    .filter(
      (close) =>
        close.id &&
        close.periodEnd.getTime() <= period.periodStart.getTime() &&
        Number(close.subtotal) < 0,
    )
    .map((close) => ({
      sourceType: 'credit_carry_forward' as const,
      sourceId: String(close.id),
      payerTenantId: tenantKey(close.payerTenantId),
      currency: normalizeCurrency(close.currency),
      lineKey: `carry-forward|${close.id}`,
      lineDescription: `Credit carried forward from ${isoDate(
        close.periodStart,
      )} to ${isoDate(new Date(close.periodEnd.getTime() - 1))}`,
      amount: Number(close.subtotal),
      quantity: 0,
      discountable: false,
      periodStart: null,
      periodEnd: null,
    }));
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Flat monthly plan fees for the period, billed in arrears once per calendar
 * month, including the month a subscription is canceled in. Provider-managed
 * subscriptions (a provider subscription id) are billed by the provider
 * itself and skipped; trials and incomplete subscriptions are not billed.
 */
async function collectFlatPlans(
  runtime: BillingRuntime,
  period: BillingPeriod,
): Promise<Candidate[]> {
  const subscriptions = await listAll(runtime.pageSize, (limit, offset) =>
    runtime.subscriptions.list({
      where: {
        // A subscription canceled during the period still owes that month.
        status: ['active', 'past_due', 'unpaid', 'canceled'],
        subscriberKind: 'tenant',
        'startedAt <': period.periodEnd.toISOString(),
      },
      orderBy: 'id ASC',
      limit,
      offset,
    }),
  );
  const planIds = [
    ...new Set(subscriptions.map((row) => String(row.planId))),
  ].filter(Boolean);
  const plans = new Map<string, SubscriptionPlan>();
  for (let offset = 0; offset < planIds.length; offset += runtime.pageSize) {
    const rows = await runtime.plans.list({
      where: { id: planIds.slice(offset, offset + runtime.pageSize) },
    });
    for (const row of rows) plans.set(String(row.id), row);
  }

  const candidates: Candidate[] = [];
  for (const subscription of subscriptions) {
    const plan = plans.get(String(subscription.planId));
    if (!plan || !isFlatBillable(subscription, plan, period)) continue;
    const planSeller = tenantKey(plan.tenantId);
    const subscriber = tenantKey(subscription.tenantId);
    let payer: string;
    if (runtime.kind === 'provider') {
      if (planSeller && planSeller !== runtime.sellerTenantId) continue;
      const relationship =
        await runtime.billingRelationships.getRelationship(subscriber);
      payer = relationship ? relationship.billingOwnerTenantId : subscriber;
    } else {
      if (planSeller !== runtime.sellerTenantId) continue;
      const relationship =
        await runtime.billingRelationships.getRelationship(subscriber);
      if (relationship?.resellerTenantId !== runtime.sellerTenantId) continue;
      payer = subscriber;
    }
    payer = tenantKey(payer);
    if (!payer || payer === runtime.sellerTenantId) continue;
    const forTenant = payer !== subscriber ? ` for tenant ${subscriber}` : '';
    candidates.push({
      sourceType: 'subscription_period',
      sourceId: `${subscription.id}:${period.periodStart.toISOString()}`,
      payerTenantId: payer,
      currency: normalizeCurrency(plan.currency),
      lineKey: `subscription|${subscription.id}`,
      lineDescription: `${plan.name || plan.planKey}${forTenant} — ${isoDate(
        period.periodStart,
      )} to ${isoDate(new Date(period.periodEnd.getTime() - 1))}`,
      amount: Number(plan.priceAmount),
      quantity: 1,
      discountable: true,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
    });
  }
  return candidates;
}

function isFlatBillable(
  subscription: TenantSubscription,
  plan: SubscriptionPlan,
  period: BillingPeriod,
): boolean {
  if (subscription.stripeSubscriptionId) return false;
  if (plan.billingInterval !== 'month') return false;
  if (!Number.isSafeInteger(plan.priceAmount) || plan.priceAmount <= 0) {
    return false;
  }
  const start = period.periodStart.getTime();
  if (subscription.status === 'canceled' && !subscription.canceledAt) {
    return false;
  }
  if (subscription.canceledAt && subscription.canceledAt.getTime() <= start) {
    return false;
  }
  if (subscription.trialEndsAt && subscription.trialEndsAt.getTime() > start) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Per-payer close
// ---------------------------------------------------------------------------

async function closeGroup(
  runtime: BillingRuntime,
  period: BillingPeriod,
  group: CandidateGroup,
  now: Date,
): Promise<PeriodCloseGroupResult> {
  const base = {
    payerTenantId: group.payerTenantId,
    currency: group.currency,
    closeId: group.closeId,
  };
  let leaseToken: string | null = null;
  try {
    const existing = await runtime.closes.get(group.closeId);
    const account = await runtime.getAccount(group.payerTenantId);
    if (!account?.id) {
      throw new Error(
        `No billing account for payer ${group.payerTenantId}; create one with upsertAccount().`,
      );
    }
    const close =
      existing ?? (await createClose(runtime, period, group, account, now));
    if (close.status === 'completed' || close.status === 'carried_forward') {
      return resultOf(base, close, close.status);
    }
    leaseToken = await runtime.acquireCloseLease(String(close.id), now);
    if (!leaseToken) return { ...base, outcome: 'busy' };
    const fresh = (await runtime.closes.get(String(close.id))) ?? close;
    const outcome = await advance(runtime, fresh, group.candidates, account);
    return resultOf(base, fresh, outcome);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await recordFailure(runtime, group.closeId, message);
    return { ...base, outcome: 'failed', error: message };
  } finally {
    if (leaseToken) {
      await runtime.releaseCloseLease(group.closeId, leaseToken);
    }
  }
}

function resultOf(
  base: { payerTenantId: string; currency: string; closeId: string },
  close: BillingPeriodClose,
  outcome: PeriodCloseOutcome,
): PeriodCloseGroupResult {
  return {
    ...base,
    outcome,
    invoiceId: close.invoiceId || undefined,
    providerInvoiceId: close.providerInvoiceId || undefined,
  };
}

async function recordFailure(
  runtime: BillingRuntime,
  closeId: string,
  message: string,
): Promise<void> {
  try {
    const close = await runtime.closes.get(closeId);
    if (!close) return;
    close.attempts = (Number(close.attempts) || 0) + 1;
    close.lastError = message.slice(0, 2000);
    await close.save();
  } catch {
    // The failure is reported in the result either way.
  }
}

async function createClose(
  runtime: BillingRuntime,
  period: BillingPeriod,
  group: CandidateGroup,
  account: BillingAccount,
  now: Date,
): Promise<BillingPeriodClose> {
  try {
    return await runtime.closes.create({
      id: group.closeId,
      sellerTenantId: runtime.sellerTenantId,
      kind: runtime.kind,
      payerTenantId: group.payerTenantId,
      currency: group.currency,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      billingAccountId: String(account.id),
      status: 'collecting',
      issuedAt: now,
      _insertOnly: true,
    });
  } catch (error) {
    const concurrent = await runtime.closes.get(group.closeId);
    if (concurrent) return concurrent;
    throw error;
  }
}

async function advance(
  runtime: BillingRuntime,
  close: BillingPeriodClose,
  candidates: Candidate[],
  account: BillingAccount,
): Promise<PeriodCloseOutcome> {
  if (close.status === 'collecting') {
    const collected = await collectAndInvoice(
      runtime,
      close,
      candidates,
      account,
    );
    if (collected === 'empty') {
      close.status = 'completed';
      await close.save();
      return 'empty';
    }
    if (collected === 'carried_forward') return 'carried_forward';
  }
  const invoice = await runtime.getInvoice(close.invoiceId);
  if (close.status === 'invoiced') {
    await pushToProvider(runtime, close, invoice, account);
  }
  if (close.status === 'pushed') {
    await sendAndReconcile(runtime, close, invoice, account);
  }
  if (close.status === 'sent') {
    await postRevenue(runtime, invoice);
    close.status = 'completed';
    close.lastError = '';
    await close.save();
  }
  return 'completed';
}

/** Claim sources, then build the invoice from everything this close owns. */
async function collectAndInvoice(
  runtime: BillingRuntime,
  close: BillingPeriodClose,
  candidates: Candidate[],
  account: BillingAccount,
): Promise<'empty' | 'carried_forward' | 'invoiced'> {
  const closeId = String(close.id);
  for (const candidate of candidates) {
    const id = await sourceId(candidate.sourceType, candidate.sourceId);
    const discount = candidate.discountable
      ? Math.round(
          (candidate.amount * Number(account.flatDiscountBasisPoints)) / 10_000,
        )
      : 0;
    try {
      await runtime.sources.create({
        id,
        sellerTenantId: runtime.sellerTenantId,
        periodCloseId: closeId,
        sourceType: candidate.sourceType,
        sourceId: candidate.sourceId,
        lineKey: candidate.lineKey,
        lineDescription: candidate.lineDescription,
        amount: candidate.amount,
        discount,
        quantity: candidate.quantity,
        currency: candidate.currency,
        periodStart: candidate.periodStart,
        periodEnd: candidate.periodEnd,
        _insertOnly: true,
      });
    } catch (error) {
      // Already claimed — by this close on an earlier attempt, or by another
      // close that won the race. Only a missing row is a real failure.
      if (!(await runtime.sources.get(id))) throw error;
    }
  }

  const sources = await listAll(runtime.pageSize, (limit, offset) =>
    runtime.sources.list({
      where: { periodCloseId: closeId },
      orderBy: 'id ASC',
      limit,
      offset,
    }),
  );
  if (sources.length === 0) return 'empty';
  // Credits this close absorbed are consumed at their original close.
  for (const source of sources) {
    if (source.sourceType !== 'credit_carry_forward') continue;
    const carried = await runtime.closes.get(source.sourceId);
    if (carried?.status === 'carried_forward') {
      carried.status = 'completed';
      await carried.save();
    }
  }
  const lines = groupLines(sources);
  const subtotal = lines.reduce(
    (sum, line) => sum + line.amount - line.discount,
    0,
  );
  if (subtotal < 0) {
    // A net credit is not invoiced. The claims stay with this close, so a
    // source's later eligibility cannot change the balance, and the credit
    // itself becomes a source the payer's next close bills.
    close.subtotal = subtotal;
    close.lineCount = lines.length;
    close.status = 'carried_forward';
    await close.save();
    return 'carried_forward';
  }

  const invoiceId = await deterministicId(['billing-invoice', closeId]);
  await withTenant({ tenantId: runtime.sellerTenantId }, async () => {
    let invoice = await runtime.invoices.get(invoiceId);
    if (!invoice) {
      const issueDate = close.issuedAt;
      const dueDate = new Date(
        issueDate.getTime() + Number(account.paymentTermsDays) * 86_400_000,
      );
      try {
        invoice = await runtime.invoices.create({
          id: invoiceId,
          tenantId: runtime.sellerTenantId,
          customerId: account.customerId,
          invoiceNumber: invoiceNumber(runtime, close, closeId),
          reference: `billing-period:${close.periodStart.toISOString()}/${close.periodEnd.toISOString()}`,
          issueDate,
          dueDate,
          currency: close.currency,
          subtotal: 0,
          taxAmount: 0,
          totalAmount: 0,
          _insertOnly: true,
        });
      } catch (error) {
        invoice = await runtime.invoices.get(invoiceId);
        if (!invoice) throw error;
      }
    }
    if (invoice.status !== InvoiceStatus.DRAFT) {
      throw new Error(`Invoice ${invoice.invoiceNumber} is no longer a draft.`);
    }
    for (const [index, line] of lines.entries()) {
      await runtime.lineItems.create({
        id: await deterministicId(['billing-invoice-line', closeId, line.key]),
        tenantId: runtime.sellerTenantId,
        invoiceId,
        description: line.description,
        quantity: 1,
        unitPrice: line.amount,
        discount: line.discount,
        taxRate: 0.0,
        amount: line.amount - line.discount,
        sourceType: 'billing_period_close',
        sourceId: closeId,
        periodStart: line.periodStart ?? close.periodStart,
        periodEnd: line.periodEnd ?? close.periodEnd,
        sortOrder: index,
      });
    }
    await invoice.save();
  });

  close.invoiceId = invoiceId;
  close.subtotal = subtotal;
  close.lineCount = lines.length;
  close.status = 'invoiced';
  await close.save();
  return 'invoiced';
}

interface InvoiceLineGroup {
  key: string;
  description: string;
  amount: number;
  discount: number;
  periodStart: Date | null;
  periodEnd: Date | null;
}

function groupLines(sources: BillingLineSource[]): InvoiceLineGroup[] {
  const lines = new Map<string, InvoiceLineGroup & { quantity: number }>();
  for (const source of sources) {
    let line = lines.get(source.lineKey);
    if (!line) {
      line = {
        key: source.lineKey,
        description: source.lineDescription,
        amount: 0,
        discount: 0,
        quantity: 0,
        periodStart: source.periodStart,
        periodEnd: source.periodEnd,
      };
      lines.set(source.lineKey, line);
    }
    line.amount += Number(source.amount);
    line.discount += Number(source.discount);
    line.quantity += Number(source.quantity) || 0;
  }
  return [...lines.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((line) => ({
      key: line.key,
      // Usage lines describe the summed quantity, not the first event's.
      description:
        line.key.startsWith('usage|') || line.key.startsWith('retail|')
          ? line.description.replace(
              / — [\d.e+-]+ units$/,
              ` — ${Number(line.quantity.toFixed(6))} units`,
            )
          : line.description,
      amount: line.amount,
      discount: line.discount,
      periodStart: line.periodStart,
      periodEnd: line.periodEnd,
    }));
}

function invoiceNumber(
  runtime: BillingRuntime,
  close: BillingPeriodClose,
  closeId: string,
): string {
  const month = close.periodStart.toISOString().slice(0, 7).replace('-', '');
  return `${runtime.invoiceNumberPrefix}-${month}-${closeId.slice(0, 8).toUpperCase()}`;
}

async function pushToProvider(
  runtime: BillingRuntime,
  close: BillingPeriodClose,
  invoice: Invoice,
  account: BillingAccount,
): Promise<void> {
  const synced = await runtime.ensureProviderCustomer(account);
  const lineItems = await withTenant({ tenantId: runtime.sellerTenantId }, () =>
    runtime.lineItems.findByInvoice(String(invoice.id)),
  );
  const lines: BillingProviderInvoiceLine[] = [];
  for (const item of [...lineItems].sort((a, b) => a.sortOrder - b.sortOrder)) {
    const gross = item.quantity * item.unitPrice;
    lines.push({
      description: item.description,
      amount: gross,
      periodStart: item.periodStart ?? undefined,
      periodEnd: item.periodEnd ?? undefined,
    });
    if (item.discount > 0) {
      lines.push({
        description: `Discount: ${item.description}`,
        amount: -item.discount,
        periodStart: item.periodStart ?? undefined,
        periodEnd: item.periodEnd ?? undefined,
      });
    }
  }
  const { providerInvoiceId } = await runtime.provider.pushInvoice({
    invoiceId: String(invoice.id),
    invoiceNumber: invoice.invoiceNumber,
    providerCustomerId: synced.providerCustomerId,
    currency: close.currency,
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    lines,
    subtotal: invoice.subtotal,
    idempotencyKey: `smrt-billing-close:${close.id}`,
    automaticTax: synced.automaticTax,
    memo: invoice.customerNotes || undefined,
  });
  await withTenant({ tenantId: runtime.sellerTenantId }, async () => {
    invoice.externalId = providerInvoiceId;
    invoice.customerExternalId = synced.providerCustomerId;
    invoice.externalProvider = runtime.provider.name;
    invoice.syncedAt = new Date();
    await invoice.save();
  });
  close.providerInvoiceId = providerInvoiceId;
  close.status = 'pushed';
  await close.save();
}

async function sendAndReconcile(
  runtime: BillingRuntime,
  close: BillingPeriodClose,
  invoice: Invoice,
  account: BillingAccount,
): Promise<void> {
  const providerInvoiceId = close.providerInvoiceId;
  let state = await runtime.provider.getInvoice(providerInvoiceId);
  if (state.status === 'draft') {
    // Re-sync the tax location: a send refused for a missing or invalid
    // address succeeds once the account is corrected.
    await runtime.ensureProviderCustomer(account);
    await runtime.provider.sendInvoice(providerInvoiceId);
    state = await runtime.provider.getInvoice(providerInvoiceId);
  }
  if (state.status === 'draft' || state.status === 'void') {
    throw new Error(
      `Provider invoice ${providerInvoiceId} is ${state.status}; expected it to be sent.`,
    );
  }
  if (
    state.currency !== close.currency ||
    state.subtotal !== invoice.subtotal ||
    state.total !== state.subtotal + state.taxAmount
  ) {
    throw new Error(
      `Provider invoice ${providerInvoiceId} does not match invoice ${invoice.invoiceNumber}: ` +
        `provider ${state.subtotal}+${state.taxAmount}=${state.total} ${state.currency}, ` +
        `local subtotal ${invoice.subtotal} ${close.currency}.`,
    );
  }
  await withTenant({ tenantId: runtime.sellerTenantId }, async () => {
    invoice.providerTaxAmount = state.taxAmount;
    if (invoice.status === InvoiceStatus.DRAFT) invoice.markSent();
    await invoice.save();
  });
  if (invoice.totalAmount !== state.total) {
    throw new Error(
      `Invoice ${invoice.invoiceNumber} total ${invoice.totalAmount} does not match provider total ${state.total}.`,
    );
  }
  close.status = 'sent';
  await close.save();
}

/**
 * Recognize revenue once. A journal posted by an attempt that died before
 * linking it is adopted instead of posting a second one.
 */
async function postRevenue(
  runtime: BillingRuntime,
  invoice: Invoice,
): Promise<void> {
  if (invoice.totalAmount <= 0 || invoice.arJournalId) return;
  await withTenant({ tenantId: runtime.sellerTenantId }, async () => {
    const posted = await runtime.journals.list({
      where: {
        sourceModule: 'smrt-commerce',
        sourceRef: String(invoice.id),
        status: 'posted',
      },
      limit: 1,
    });
    if (posted[0]?.id) {
      invoice.arJournalId = String(posted[0].id);
      await invoice.save();
      return;
    }
    await invoice.recognizeRevenue({
      arAccountId: runtime.ledger.arAccountId,
      revenueAccountId: runtime.ledger.revenueAccountId,
      taxAccountId: runtime.ledger.taxAccountId,
    });
  });
}
