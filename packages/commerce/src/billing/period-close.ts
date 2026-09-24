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
 *   many periods or workers race for it; a flat plan's claims record the time
 *   they cover and are numbered per subscription (#3116), so no two claims
 *   for one subscription ever cover the same time, whatever schedule each
 *   payer is on;
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
import {
  billingPeriodContaining,
  lastEndedBillingPeriod,
  prorateMinorUnits,
  type ScheduledBillingPeriod,
} from './cycles.js';
import type { BillingProviderInvoiceLine } from './provider.js';
import type { BillingRuntime } from './runtime.js';
import {
  deterministicId,
  isTenantId,
  normalizeCurrency,
  tenantKey,
} from './units.js';

export interface BillingPeriod {
  /** Inclusive start. */
  periodStart: Date;
  /** Exclusive end; charges approved before it are billable. */
  periodEnd: Date;
}

/**
 * Without a period, each payer's most recent ended period on its own schedule
 * is closed (#3116): the previous calendar month for a payer without a
 * billing anchor, the last anchor-to-anchor period for one with. With a
 * period, that exact period is closed for every calendar-schedule payer (flat
 * plans only when it is a calendar month) and for each anchored payer whose
 * schedule contains exactly that period.
 */
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
  /** The payer's period this group closed (#3116). */
  periodStart: Date;
  periodEnd: Date;
  closeId?: string;
  invoiceId?: string;
  providerInvoiceId?: string;
  outcome: PeriodCloseOutcome;
  error?: string;
}

/**
 * `periodStart`/`periodEnd` are the explicit period, or the previous calendar
 * month for a close without one; each group carries the payer's own period.
 */
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
  /** A flat plan's billable window, claimed by `claimFlatWindow()`. */
  flat?: FlatWindow;
}

interface FlatWindow {
  subscriptionId: string;
  /** The plan's full-cycle price in minor units. */
  planAmount: number;
  /** Plan name and tenant suffix for the line description. */
  label: string;
  windowStart: Date;
  windowEnd: Date;
  cycleMs: number;
}

interface CandidateGroup {
  payerTenantId: string;
  currency: string;
  closeId: string;
  period: ScheduledBillingPeriod;
  candidates: Candidate[];
}

/** How one payer is closed in this run. */
interface PayerSchedule {
  /** The period to close, or null when the payer is not closed this run. */
  period: ScheduledBillingPeriod | null;
  /** Whether flat plans are billed for that period. */
  billsFlatPlans: boolean;
  prorate: boolean;
}

type CloseMode =
  | { kind: 'due'; now: Date }
  | { kind: 'explicit'; period: BillingPeriod };

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

function resolveMode(input: ClosePeriodInput): CloseMode {
  const now = input.now ?? new Date();
  if (!input.periodStart && !input.periodEnd) return { kind: 'due', now };
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
  if (period.periodEnd.getTime() > now.getTime()) {
    throw new Error('A billing period cannot be closed before it ends.');
  }
  return { kind: 'explicit', period };
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

function samePeriod(a: BillingPeriod, b: BillingPeriod): boolean {
  return (
    a.periodStart.getTime() === b.periodStart.getTime() &&
    a.periodEnd.getTime() === b.periodEnd.getTime()
  );
}

/** Each payer's schedule for one run, read once from its billing account. */
class PayerSchedules {
  private readonly cache = new Map<string, Promise<PayerSchedule>>();

  constructor(
    private readonly runtime: BillingRuntime,
    private readonly mode: CloseMode,
  ) {}

  get(payerTenantId: string): Promise<PayerSchedule> {
    const key = tenantKey(payerTenantId);
    let schedule = this.cache.get(key);
    if (!schedule) {
      schedule = this.resolve(key);
      this.cache.set(key, schedule);
    }
    return schedule;
  }

  private async resolve(payer: string): Promise<PayerSchedule> {
    // A payer without an account keeps the calendar schedule; its close then
    // fails with a clear "no billing account" error, as before #3116.
    const account = isTenantId(payer)
      ? await this.runtime.getAccount(payer)
      : null;
    const anchor = account?.billingAnchorAt ?? null;
    const prorate = Boolean(account?.prorateFlatPlans);
    if (this.mode.kind === 'due') {
      return {
        period: lastEndedBillingPeriod(anchor, this.mode.now),
        billsFlatPlans: true,
        prorate,
      };
    }
    const explicit = this.mode.period;
    if (!anchor) {
      return {
        period: {
          ...explicit,
          cycleStart: explicit.periodStart,
          cycleEnd: explicit.periodEnd,
        },
        billsFlatPlans: isCalendarMonth(explicit),
        prorate,
      };
    }
    // An anchored payer is closed only for a period of its own schedule.
    const scheduled = billingPeriodContaining(anchor, explicit.periodStart);
    const matches = samePeriod(scheduled, explicit);
    return {
      period: matches ? scheduled : null,
      billsFlatPlans: matches,
      prorate,
    };
  }
}

/**
 * Close billing periods for a runtime's seller: each payer's last ended
 * period, or one explicit period (see {@link ClosePeriodInput}). Idempotent:
 * re-running it resumes unfinished payers and bills nothing twice.
 */
export async function closeBillingPeriod(
  runtime: BillingRuntime,
  input: ClosePeriodInput = {},
): Promise<PeriodCloseResult> {
  const mode = resolveMode(input);
  const now = input.now ?? new Date();
  const schedules = new PayerSchedules(runtime, mode);
  const groups = await withSystemContext(() =>
    collectGroups(runtime, mode, schedules),
  );
  // Closes still in progress, including ones whose every source was already
  // claimed (a collection query no longer returns them).
  const unfinished = await runtime.closes.list({
    where: {
      sellerTenantId: runtime.sellerTenantId,
      kind: runtime.kind,
      'status !=': 'completed',
    },
  });
  const results: PeriodCloseGroupResult[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    seen.add(group.closeId);
    results.push(await closeGroup(runtime, group, now));
  }
  // Resume unfinished closes: with an explicit period, those of that period
  // whose sources were all claimed on an earlier attempt; without one, every
  // unfinished close whose period has ended, whatever the payer's schedule is
  // now — a close stranded by a re-anchor would otherwise hold its claims
  // (time later closes treat as billed) without ever invoicing them.
  for (const close of unfinished) {
    if (
      !close.id ||
      seen.has(close.id) ||
      close.status === 'completed' ||
      close.status === 'carried_forward'
    ) {
      continue;
    }
    const resumable =
      mode.kind === 'explicit'
        ? samePeriod(close, mode.period)
        : close.periodEnd.getTime() <= now.getTime();
    const period: ScheduledBillingPeriod | null = resumable
      ? {
          periodStart: close.periodStart,
          periodEnd: close.periodEnd,
          cycleStart: close.periodStart,
          cycleEnd: close.periodEnd,
        }
      : null;
    if (!period) continue;
    results.push(
      await closeGroup(
        runtime,
        {
          payerTenantId: close.payerTenantId,
          currency: close.currency,
          closeId: close.id,
          period,
          candidates: [],
        },
        now,
      ),
    );
  }
  const result: PeriodCloseResult = {
    sellerTenantId: runtime.sellerTenantId,
    ...(mode.kind === 'explicit' ? mode.period : previousCalendarMonth(now)),
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
  mode: CloseMode,
  schedules: PayerSchedules,
): Promise<CandidateGroup[]> {
  // Nothing after this instant is billable to any payer this run; each
  // collector narrows it to the payer's own period end.
  const bound = mode.kind === 'explicit' ? mode.period.periodEnd : mode.now;
  const candidates: Candidate[] = [];
  if (runtime.kind === 'provider') {
    candidates.push(...(await collectClientCharges(runtime, bound, schedules)));
    candidates.push(...(await collectAdjustments(runtime, bound, schedules)));
  } else {
    candidates.push(...(await collectRetailCharges(runtime, bound, schedules)));
  }
  candidates.push(...(await collectFlatPlans(runtime, bound, schedules)));
  candidates.push(...(await collectCarriedCredits(runtime, schedules)));

  const byGroup = new Map<string, CandidateGroup>();
  for (const candidate of candidates) {
    const key = `${candidate.payerTenantId}|${candidate.currency}`;
    let group = byGroup.get(key);
    if (!group) {
      const { period } = await schedules.get(candidate.payerTenantId);
      if (!period) continue;
      group = {
        payerTenantId: candidate.payerTenantId,
        currency: candidate.currency,
        closeId: await periodCloseId(
          runtime,
          candidate.payerTenantId,
          candidate.currency,
          period,
        ),
        period,
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
  const flatClaims = await loadFlatClaims(
    runtime,
    candidates.flatMap((candidate) => (candidate.flat ? [candidate.flat] : [])),
  );
  for (const group of groups) {
    const ids = await Promise.all(
      group.candidates.map((candidate) =>
        candidate.flat
          ? ''
          : sourceId(candidate.sourceType, candidate.sourceId),
      ),
    );
    const claimed = new Map<string, string>();
    const lookup = ids.filter(Boolean);
    for (let offset = 0; offset < lookup.length; offset += runtime.pageSize) {
      const rows = await runtime.sources.list({
        where: { id: lookup.slice(offset, offset + runtime.pageSize) },
      });
      for (const row of rows) {
        if (row.id) claimed.set(row.id, row.periodCloseId);
      }
    }
    group.candidates = group.candidates.filter((candidate, index) => {
      if (candidate.flat) {
        const claims = flatClaims.get(candidate.flat.subscriptionId) ?? [];
        return (
          claims.some((claim) => claim.periodCloseId === group.closeId) ||
          uncovered(candidate.flat, claims).length > 0
        );
      }
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

interface UnclaimedRow {
  id: string;
  payer: string;
  at: Date;
}

/**
 * Rows in `table` matching `where` that no close has claimed yet, with their
 * payer (`tenant_id`) and billing instant. The anti-join keeps each run
 * proportional to unbilled work rather than to the whole charge history.
 */
async function unclaimedRows(
  runtime: BillingRuntime,
  table: string,
  sourceType: BillingLineSourceType,
  atColumn: string,
  where: string,
  params: unknown[],
): Promise<UnclaimedRow[]> {
  const rows: UnclaimedRow[] = [];
  for (let offset = 0; ; offset += runtime.pageSize) {
    const result = await runtime.db.query(
      `SELECT c.id AS id, c.tenant_id AS payer, c.${atColumn} AS at
         FROM ${table} c
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
    for (const row of result.rows) {
      rows.push({
        id: String(row.id),
        payer: tenantKey(row.payer as string | null),
        at: new Date(row.at as string | Date),
      });
    }
    if (result.rows.length < runtime.pageSize) return rows;
  }
}

/** Ids of rows billable in their payer's period this run. */
async function billableIds(
  rows: UnclaimedRow[],
  schedules: PayerSchedules,
): Promise<string[]> {
  const ids: string[] = [];
  for (const row of rows) {
    const { period } = await schedules.get(row.payer);
    if (period && row.at.getTime() < period.periodEnd.getTime()) {
      ids.push(row.id);
    }
  }
  return ids;
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
  bound: Date,
  schedules: PayerSchedules,
): Promise<Candidate[]> {
  const books = await sellerBookIds(runtime);
  const ids = await billableIds(
    await unclaimedRows(
      runtime,
      '_smrt_client_charges',
      'client_charge',
      'approved_at',
      "c.status IN ('approved', 'adjusted') AND c.approved_at < ?",
      [bound.toISOString()],
    ),
    schedules,
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
  bound: Date,
  schedules: PayerSchedules,
): Promise<Candidate[]> {
  const books = await sellerBookIds(runtime);
  const ids = await billableIds(
    await unclaimedRows(
      runtime,
      '_smrt_billing_adjustments',
      'billing_adjustment',
      'created_at',
      'c.created_at < ?',
      [bound.toISOString()],
    ),
    schedules,
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
  bound: Date,
  schedules: PayerSchedules,
): Promise<Candidate[]> {
  const ids = await billableIds(
    await unclaimedRows(
      runtime,
      '_smrt_retail_charges',
      'retail_charge',
      'approved_at',
      "c.reseller_tenant_id = ? AND c.status = 'approved' AND c.approved_at < ?",
      [runtime.sellerTenantId, bound.toISOString()],
    ),
    schedules,
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
  schedules: PayerSchedules,
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
  const candidates: Candidate[] = [];
  for (const close of carried) {
    if (!close.id || !(Number(close.subtotal) < 0)) continue;
    const { period } = await schedules.get(close.payerTenantId);
    if (!period || close.periodEnd.getTime() > period.periodStart.getTime()) {
      continue;
    }
    candidates.push({
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
    });
  }
  return candidates;
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Flat monthly plan fees, billed in arrears for each payer's period,
 * including the period a subscription is canceled in. Provider-managed
 * subscriptions (a provider subscription id) are billed by the provider
 * itself and skipped; incomplete subscriptions are not billed, and trials
 * are not billed (with proration, only the trial's time is not billed).
 */
async function collectFlatPlans(
  runtime: BillingRuntime,
  bound: Date,
  schedules: PayerSchedules,
): Promise<Candidate[]> {
  const subscriptions = await listAll(runtime.pageSize, (limit, offset) =>
    runtime.subscriptions.list({
      where: {
        // A subscription canceled during the period still owes that period.
        status: ['active', 'past_due', 'unpaid', 'canceled'],
        subscriberKind: 'tenant',
        'startedAt <': bound.toISOString(),
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
    if (!subscription.id || !plan || !isFlatPlan(subscription, plan)) continue;
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
    const schedule = await schedules.get(payer);
    if (!schedule.period || !schedule.billsFlatPlans) continue;
    const window = flatWindow(subscription, schedule.period, schedule.prorate);
    if (!window) continue;
    const forTenant = payer !== subscriber ? ` for tenant ${subscriber}` : '';
    candidates.push({
      sourceType: 'subscription_period',
      // Assigned when claimed: the claim's number for its subscription.
      sourceId: '',
      payerTenantId: payer,
      currency: normalizeCurrency(plan.currency),
      lineKey: flatLineKey(String(subscription.id)),
      lineDescription: '',
      amount: 0,
      quantity: 1,
      discountable: true,
      periodStart: window.start,
      periodEnd: window.end,
      flat: {
        subscriptionId: String(subscription.id),
        planAmount: Number(plan.priceAmount),
        label: `${plan.name || plan.planKey}${forTenant}`,
        windowStart: window.start,
        windowEnd: window.end,
        cycleMs:
          schedule.period.cycleEnd.getTime() -
          schedule.period.cycleStart.getTime(),
      },
    });
  }
  return candidates;
}

/** Period-independent eligibility of a flat plan subscription. */
function isFlatPlan(
  subscription: TenantSubscription,
  plan: SubscriptionPlan,
): boolean {
  if (subscription.stripeSubscriptionId) return false;
  if (plan.billingInterval !== 'month') return false;
  if (!Number.isSafeInteger(plan.priceAmount) || plan.priceAmount <= 0) {
    return false;
  }
  if (subscription.status === 'canceled' && !subscription.canceledAt) {
    return false;
  }
  return true;
}

/**
 * The part of `period` a subscription is billed for, or null. Without
 * proration that is the whole period if the subscription was active in it
 * and out of trial at its start; with proration it is exactly the time the
 * subscription was active and out of trial.
 */
function flatWindow(
  subscription: TenantSubscription,
  period: BillingPeriod,
  prorate: boolean,
): { start: Date; end: Date } | null {
  const start = period.periodStart.getTime();
  const end = period.periodEnd.getTime();
  const startedAt = subscription.startedAt.getTime();
  const canceledAt = subscription.canceledAt?.getTime();
  const trialEndsAt = subscription.trialEndsAt?.getTime();
  if (!(startedAt < end)) return null;
  if (canceledAt !== undefined && canceledAt <= start) return null;
  if (!prorate) {
    if (trialEndsAt !== undefined && trialEndsAt > start) return null;
    return { start: period.periodStart, end: period.periodEnd };
  }
  const from = Math.max(start, startedAt, trialEndsAt ?? start);
  const to = Math.min(end, canceledAt ?? end);
  return to > from ? { start: new Date(from), end: new Date(to) } : null;
}

// ---------------------------------------------------------------------------
// Flat-plan coverage
// ---------------------------------------------------------------------------

function flatLineKey(subscriptionId: string): string {
  return `subscription|${subscriptionId}`;
}

/**
 * Flat-plan claims of each subscription that overlap the windows being
 * billed (ending after the earliest start and starting before the latest
 * end), by subscription id. The read is bounded by those windows, not by
 * billing history.
 */
async function loadFlatClaims(
  runtime: BillingRuntime,
  flats: FlatWindow[],
): Promise<Map<string, BillingLineSource[]>> {
  const bySubscription = new Map<string, [number, number]>();
  for (const flat of flats) {
    const start = flat.windowStart.getTime();
    const end = flat.windowEnd.getTime();
    const known = bySubscription.get(flat.subscriptionId);
    bySubscription.set(
      flat.subscriptionId,
      known
        ? [Math.min(known[0], start), Math.max(known[1], end)]
        : [start, end],
    );
  }
  const entries = [...bySubscription.entries()];
  const claims = new Map<string, BillingLineSource[]>();
  for (let offset = 0; offset < entries.length; offset += runtime.pageSize) {
    const batch = entries.slice(offset, offset + runtime.pageSize);
    const after = Math.min(...batch.map(([, [start]]) => start));
    const before = Math.max(...batch.map(([, [, end]]) => end));
    const rows = await runtime.sources.list({
      where: {
        sourceType: 'subscription_period',
        lineKey: batch.map(([subscriptionId]) => flatLineKey(subscriptionId)),
        'periodEnd >': new Date(after).toISOString(),
        'periodStart <': new Date(before).toISOString(),
      },
    });
    for (const row of rows) {
      const subscriptionId = row.lineKey.slice('subscription|'.length);
      const list = claims.get(subscriptionId) ?? [];
      list.push(row);
      claims.set(subscriptionId, list);
    }
  }
  return claims;
}

/** The parts of a flat window no existing claim covers, in order. */
function uncovered(
  flat: FlatWindow,
  claims: BillingLineSource[],
): Array<[number, number]> {
  const start = flat.windowStart.getTime();
  const end = flat.windowEnd.getTime();
  const covered = claims
    .filter((claim) => claim.periodStart && claim.periodEnd)
    .map(
      (claim) =>
        [
          (claim.periodStart as Date).getTime(),
          (claim.periodEnd as Date).getTime(),
        ] as [number, number],
    )
    .filter(([from, to]) => from < end && to > start)
    .sort((a, b) => a[0] - b[0]);
  const gaps: Array<[number, number]> = [];
  let cursor = start;
  for (const [from, to] of covered) {
    if (from > cursor) gaps.push([cursor, Math.min(from, end)]);
    cursor = Math.max(cursor, to);
    if (cursor >= end) break;
  }
  if (cursor < end) gaps.push([cursor, end]);
  return gaps.filter(([from, to]) => to > from);
}

/** The subscription's highest claim sequence number (0 before its first). */
async function lastFlatSequence(
  runtime: BillingRuntime,
  subscriptionId: string,
): Promise<number> {
  const [last] = await runtime.sources.list({
    where: {
      sourceType: 'subscription_period',
      lineKey: flatLineKey(subscriptionId),
    },
    orderBy: 'chainSequence DESC',
    limit: 1,
  });
  return Number(last?.chainSequence) || 0;
}

function flatSourceId(subscriptionId: string, sequence: number): string {
  return `${subscriptionId}:seq:${sequence}`;
}

const MAX_FLAT_CLAIM_CONFLICTS = 8;

/**
 * Claim every uncovered part of a flat window for `closeId`, one claim per
 * gap, each priced as the plan amount × gap length / cycle length (rounded
 * half up) and recording exactly the time it bills.
 *
 * A subscription's claims are numbered 1, 2, 3, … and a claim's id is derived
 * from its number, so only one claimer can ever take number n + 1. A claimer
 * reads the last number n first and the coverage second; every claim up to n
 * was committed before claim n was, so the coverage read sees them all, and a
 * claim written after the first read takes n + 1 and makes this insert
 * conflict. A conflicting claimer re-reads and retries.
 */
async function claimFlatWindow(
  runtime: BillingRuntime,
  closeId: string,
  candidate: Candidate,
  flat: FlatWindow,
  account: BillingAccount,
): Promise<void> {
  let conflicts = 0;
  for (;;) {
    const sequence = (await lastFlatSequence(runtime, flat.subscriptionId)) + 1;
    const claims =
      (await loadFlatClaims(runtime, [flat])).get(flat.subscriptionId) ?? [];
    const gap = uncovered(flat, claims)
      .map(([from, to]) => ({
        from,
        to,
        amount: prorateMinorUnits(flat.planAmount, to - from, flat.cycleMs),
      }))
      .find((part) => part.amount > 0);
    if (!gap) return;
    const billedStart = new Date(gap.from);
    const billedEnd = new Date(gap.to);
    const claimSourceId = flatSourceId(flat.subscriptionId, sequence);
    const id = await sourceId('subscription_period', claimSourceId);
    const prorated = gap.to - gap.from < flat.cycleMs ? ' (prorated)' : '';
    try {
      await runtime.sources.create({
        id,
        sellerTenantId: runtime.sellerTenantId,
        periodCloseId: closeId,
        sourceType: 'subscription_period',
        sourceId: claimSourceId,
        chainSequence: sequence,
        lineKey: candidate.lineKey,
        lineDescription: `${flat.label} — ${isoDate(billedStart)} to ${isoDate(
          new Date(billedEnd.getTime() - 1),
        )}${prorated}`,
        amount: gap.amount,
        discount: flatDiscount(gap.amount, account),
        quantity: 1,
        currency: candidate.currency,
        periodStart: billedStart,
        periodEnd: billedEnd,
        _insertOnly: true,
      });
    } catch (error) {
      // Another claim took this number: re-read and retry.
      if (!(await runtime.sources.get(id))) throw error;
      conflicts += 1;
      if (conflicts >= MAX_FLAT_CLAIM_CONFLICTS) {
        throw new Error(
          `Could not claim subscription ${flat.subscriptionId}: its billed coverage kept changing.`,
        );
      }
    }
  }
}

function flatDiscount(amount: number, account: BillingAccount): number {
  return Math.round(
    (amount * Number(account.flatDiscountBasisPoints)) / 10_000,
  );
}

// ---------------------------------------------------------------------------
// Per-payer close
// ---------------------------------------------------------------------------

async function closeGroup(
  runtime: BillingRuntime,
  group: CandidateGroup,
  now: Date,
): Promise<PeriodCloseGroupResult> {
  const { period } = group;
  const base = {
    payerTenantId: group.payerTenantId,
    currency: group.currency,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
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
  base: Omit<PeriodCloseGroupResult, 'outcome'>,
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
    if (candidate.flat) {
      await claimFlatWindow(
        runtime,
        closeId,
        candidate,
        candidate.flat,
        account,
      );
      continue;
    }
    const id = await sourceId(candidate.sourceType, candidate.sourceId);
    const discount = candidate.discountable
      ? flatDiscount(candidate.amount, account)
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
    // Each numbered flat claim (#3116) is its own line with its own service
    // period, keyed by the claim alone so a resumed close rebuilds the same
    // line ids whatever other claims it gained; pre-#3116 claims (number 0)
    // keep their original key.
    const key =
      source.sourceType === 'subscription_period' &&
      Number(source.chainSequence) > 0
        ? `${source.lineKey}|${source.periodStart?.toISOString() ?? ''}`
        : source.lineKey;
    let line = lines.get(key);
    if (!line) {
      line = {
        key,
        description: source.lineDescription,
        amount: 0,
        discount: 0,
        quantity: 0,
        periodStart: source.periodStart,
        periodEnd: source.periodEnd,
      };
      lines.set(key, line);
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
