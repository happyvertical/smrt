import type { ServiceTimeEntry } from '../models/service-time-entry.js';
import type {
  CommercialSnapshot,
  ServiceCommercialResolver,
} from './service-evidence-service.js';

/** Explicit hourly rate in currency minor units, with immutable host provenance. */
export interface DatedLabourRate {
  id: string;
  version: string;
  /** Nonnegative plain decimal text, at most 18 fractional digits. */
  rateMinor: string;
}

/** A half-open effective period. An omitted end means no upper bound. */
export interface DatedLabourRatePeriod {
  effectiveFrom: string;
  effectiveUntil?: string;
  currency: string;
  customer: DatedLabourRate;
  wage: DatedLabourRate;
  /** Additive hourly burden amount; never a percentage or statutory default. */
  burden: DatedLabourRate;
}

/**
 * Trusted host input: authorize this tenant, worker and schedule before use.
 * Dates are YYYY-MM-DD calendar dates, never inferred from process time.
 */
export interface DatedLabourCommercialInput {
  tenantId: string;
  participantProfileId: string;
  workDate: string;
  currency: string;
  billable: boolean;
  schedule: readonly DatedLabourRatePeriod[];
}

type Rational = { numerator: bigint; denominator: bigint };
const MAX = BigInt(Number.MAX_SAFE_INTEGER);

function decimal(value: string, label: string): Rational {
  if (
    typeof value !== 'string' ||
    value.length > 40 ||
    !/^\d+(?:\.\d{1,18})?$/.test(value)
  )
    throw new Error(`${label} must be nonnegative plain decimal text.`);
  const [whole, fraction = ''] = value.split('.');
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(whole + fraction);
  if (numerator > MAX * denominator)
    throw new Error(`${label} exceeds the safe numeric range.`);
  return { numerator, denominator };
}

function date(value: string): void {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value.startsWith('0000-')
  )
    throw new Error('Expected a valid YYYY-MM-DD calendar date.');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  )
    throw new Error('Expected a valid YYYY-MM-DD calendar date.');
}

function identity(value: string, label: string): void {
  if (typeof value !== 'string' || !value.trim())
    throw new Error(`${label} is required.`);
}

function rate(value: DatedLabourRate): DatedLabourRate {
  if (!value || typeof value !== 'object') throw new Error('Rate is required.');
  identity(value.id, 'Rate id');
  identity(value.version, 'Rate version');
  decimal(value.rateMinor, 'Hourly rate');
  // Whitelist fields: never copy arbitrary host/private facts to client terms.
  return { id: value.id, version: value.version, rateMinor: value.rateMinor };
}

function amount(hours: Rational, hourly: DatedLabourRate): number {
  const value = decimal(hourly.rateMinor, 'Hourly rate');
  const numerator = hours.numerator * value.numerator;
  const denominator = hours.denominator * value.denominator;
  // Exact nonnegative half-up rounding, once per independent component.
  const result = (2n * numerator + denominator) / (2n * denominator);
  if (result > MAX)
    throw new Error('Labour amount exceeds safe integer minor units.');
  return Number(result);
}

/**
 * Opt-in effective-dated labour calculator behind ServiceCommercialResolver.
 * Copies selected authorized terms at construction. Retain those same terms
 * when reconstructing a resolver for an incomplete approval retry. Wage and
 * burden are rounded separately then summed; neither appears in client terms.
 */
export class DatedLabourCommercialResolver
  implements ServiceCommercialResolver
{
  private readonly input: Omit<DatedLabourCommercialInput, 'schedule'>;
  private readonly selected: DatedLabourRatePeriod;

  constructor(input: DatedLabourCommercialInput) {
    identity(input.tenantId, 'Tenant id');
    identity(input.participantProfileId, 'Worker profile id');
    date(input.workDate);
    if (
      typeof input.currency !== 'string' ||
      !/^[A-Z]{3}$/.test(input.currency)
    )
      throw new Error(
        'Currency must be an explicit three-letter uppercase code.',
      );
    if (typeof input.billable !== 'boolean')
      throw new Error('Billable must be explicit.');
    if (!Array.isArray(input.schedule) || !input.schedule.length)
      throw new Error('A rate schedule is required.');
    const schedule = input.schedule
      .map((period) => {
        date(period.effectiveFrom);
        if (period.effectiveUntil !== undefined) {
          date(period.effectiveUntil);
          if (period.effectiveUntil <= period.effectiveFrom)
            throw new Error('Effective period must have positive length.');
        }
        if (period.currency !== input.currency)
          throw new Error('Rate schedule currency mismatch.');
        return {
          effectiveFrom: period.effectiveFrom,
          effectiveUntil: period.effectiveUntil,
          currency: period.currency,
          customer: rate(period.customer),
          wage: rate(period.wage),
          burden: rate(period.burden),
        };
      })
      .sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
    for (let i = 1; i < schedule.length; i++) {
      const previousEnd = schedule[i - 1].effectiveUntil;
      if (previousEnd === undefined || previousEnd > schedule[i].effectiveFrom)
        throw new Error('Overlapping or ambiguous rate schedule.');
    }
    const selected = schedule.find(
      (period) =>
        period.effectiveFrom <= input.workDate &&
        (period.effectiveUntil === undefined ||
          input.workDate < period.effectiveUntil),
    );
    if (!selected) throw new Error('No applicable labour rate for work date.');
    this.selected = selected;
    this.input = {
      tenantId: input.tenantId,
      participantProfileId: input.participantProfileId,
      workDate: input.workDate,
      currency: input.currency,
      billable: input.billable,
    };
  }

  private resolve(entry: ServiceTimeEntry) {
    if (
      entry.tenantId !== this.input.tenantId ||
      entry.participantKind !== 'human' ||
      entry.participantProfileId !== this.input.participantProfileId
    )
      throw new Error('Labour entry tenant/worker identity mismatch.');
    const text = entry.durationHoursExact();
    let hours: Rational;
    let quantity: { hours: string } | { seconds: number };
    if (text !== null) {
      if (entry.durationSeconds !== null || entry.startedAt || entry.endedAt)
        throw new Error('Ambiguous hours and measured duration.');
      hours = decimal(text, 'Duration hours');
      quantity = { hours: text };
    } else {
      const seconds = entry.durationSeconds;
      if (!Number.isSafeInteger(seconds) || seconds === null || seconds <= 0)
        throw new Error('Duration seconds must be a positive safe integer.');
      hours = { numerator: BigInt(seconds), denominator: 3600n };
      quantity = { seconds };
    }
    if (hours.numerator <= 0n)
      throw new Error('Duration hours must be positive.');
    const customer = amount(hours, this.selected.customer);
    const wage = amount(hours, this.selected.wage);
    const burden = amount(hours, this.selected.burden);
    if (BigInt(wage) + BigInt(burden) > MAX)
      throw new Error('Compensation total exceeds safe integer minor units.');
    const common = {
      workDate: this.input.workDate,
      effectiveFrom: this.selected.effectiveFrom,
      ...(this.selected.effectiveUntil === undefined
        ? {}
        : { effectiveUntil: this.selected.effectiveUntil }),
      currency: this.input.currency,
      billable: this.input.billable,
      quantity,
      rounding: 'half-up-per-component',
    };
    return {
      client: {
        amount: this.input.billable ? customer : 0,
        currency: this.input.currency,
        version: 'dated-labour-v1',
        strategy: 'dated-hourly-labour',
        terms: { ...common, customer: { ...this.selected.customer } },
      },
      provider: {
        amount: wage + burden,
        currency: this.input.currency,
        version: 'dated-labour-v1',
        terms: {
          ...common,
          wage: { ...this.selected.wage, amount: wage },
          burden: { ...this.selected.burden, amount: burden },
        },
      },
    };
  }

  /** Validate both results before ServiceEvidenceService freezes an entry. */
  validateEntry(entry: ServiceTimeEntry): void {
    this.resolve(entry);
  }

  /** Client-only terms: no wage, burden or compensation rate provenance. */
  async priceClient(entry: ServiceTimeEntry): Promise<CommercialSnapshot> {
    return this.resolve(entry).client;
  }

  /** Private wage and burden components, independently rounded and preserved. */
  async compensateProvider(
    entry: ServiceTimeEntry,
  ): Promise<CommercialSnapshot> {
    return this.resolve(entry).provider;
  }
}
