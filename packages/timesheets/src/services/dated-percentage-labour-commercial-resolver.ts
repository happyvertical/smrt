import type { ServiceTimeEntry } from '../models/service-time-entry.js';
import {
  type DatedLabourCommercialInput,
  DatedLabourCommercialResolver,
  type DatedLabourRatePeriod,
} from './dated-labour-commercial-resolver.js';
import {
  decimal,
  identity,
  MAX,
  multiply,
  quantity,
  rounded,
} from './labour-math.js';
import type {
  CommercialSnapshot,
  ServiceCommercialResolver,
} from './service-evidence-service.js';

/** Explicit percentage points, not hourly minor units or a decimal fraction. */
export interface LabourBurdenPercent {
  id: string;
  version: string;
  /** Nonnegative plain decimal text, at most 18 fractional digits. */
  percent: string;
}

/** Percentage burden applied to the selected wage, without hourly rounding. */
export interface DatedPercentageLabourRatePeriod
  extends Omit<DatedLabourRatePeriod, 'burden'> {
  burdenPercent: LabourBurdenPercent;
}

/** Host-authorized immutable terms; host owns policy selection and input precision. */
export interface DatedPercentageLabourCommercialInput
  extends Omit<DatedLabourCommercialInput, 'schedule'> {
  schedule: readonly DatedPercentageLabourRatePeriod[];
}

/**
 * Opt-in percentage calculation. Existing additive resolver semantics are unchanged.
 * Copy and retain this same input for incomplete approval retries. Provider amount
 * is wage only; all burden provenance stays in the private compensation snapshot.
 */
export class DatedPercentageLabourCommercialResolver
  implements ServiceCommercialResolver
{
  private readonly delegate: DatedLabourCommercialResolver;
  private readonly selected: DatedPercentageLabourRatePeriod;

  constructor(input: DatedPercentageLabourCommercialInput) {
    if (!Array.isArray(input.schedule) || !input.schedule.length)
      throw new Error('A rate schedule is required.');
    const schedule = input.schedule.map((period) => {
      if ('burden' in period)
        throw new Error('Percentage and hourly burden are exclusive.');
      const percent = period.burdenPercent;
      if (!percent || typeof percent !== 'object')
        throw new Error('Burden percentage is required.');
      identity(percent.id, 'Percentage id');
      identity(percent.version, 'Percentage version');
      decimal(percent.percent, 'Burden percent');
      return {
        ...period,
        customer: { ...period.customer },
        wage: { ...period.wage },
        burdenPercent: {
          id: percent.id,
          version: percent.version,
          percent: percent.percent,
        },
      };
    });
    // Reuse all established date, currency, rate, schedule and identity validation.
    this.delegate = new DatedLabourCommercialResolver({
      ...input,
      schedule: schedule.map((period) => ({
        effectiveFrom: period.effectiveFrom,
        effectiveUntil: period.effectiveUntil,
        currency: period.currency,
        customer: period.customer,
        wage: period.wage,
        burden: {
          id: period.burdenPercent.id,
          version: period.burdenPercent.version,
          rateMinor: '0',
        },
      })),
    });
    this.selected = schedule.find(
      (period) =>
        period.effectiveFrom <= input.workDate &&
        (period.effectiveUntil === undefined ||
          input.workDate < period.effectiveUntil),
    )!;
  }

  private burden(entry: ServiceTimeEntry) {
    this.delegate.validateEntry(entry);
    const hours = entry.durationHoursExact();
    const q = quantity(
      hours === null ? { seconds: entry.durationSeconds } : { hours },
    );
    const percent = decimal(
      this.selected.burdenPercent.percent,
      'Burden percent',
    );
    const hourly = multiply(
      decimal(this.selected.wage.rateMinor, 'Hourly wage'),
      { numerator: percent.numerator, denominator: percent.denominator * 100n },
    );
    const wage = rounded(
      multiply(q, decimal(this.selected.wage.rateMinor, 'Hourly wage')),
    );
    const burden = rounded(multiply(q, hourly));
    if (BigInt(wage) + BigInt(burden) > MAX)
      throw new Error('Loaded labour cost exceeds safe integer minor units.');
    return { wage, burden, hourly };
  }

  /** Validate all private amounts before any approval mutation. */
  validateEntry(entry: ServiceTimeEntry): void {
    this.burden(entry);
  }

  /** Customer terms remain the original additive resolver's public allowlist. */
  async priceClient(entry: ServiceTimeEntry): Promise<CommercialSnapshot> {
    this.validateEntry(entry);
    return this.delegate.priceClient(entry);
  }

  /** Exact derived hourly rational is provenance, never an intermediate rounded rate. */
  async compensateProvider(
    entry: ServiceTimeEntry,
  ): Promise<CommercialSnapshot> {
    const result = this.burden(entry);
    const original = await this.delegate.compensateProvider(entry);
    const { burden: _unused, ...terms } = original.terms;
    return {
      ...original,
      version: 'dated-percentage-labour-v1',
      terms: {
        ...terms,
        loadedCostMinor: result.wage + result.burden,
        burdenPercent: {
          ...this.selected.burdenPercent,
          amount: result.burden,
        },
        burdenBasis: {
          wageId: this.selected.wage.id,
          wageVersion: this.selected.wage.version,
          hourlyNumerator: result.hourly.numerator.toString(),
          hourlyDenominator: result.hourly.denominator.toString(),
        },
      },
    };
  }
}
