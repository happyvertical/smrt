/** Trusted scope resolved and authorized by the consumer's server. */
export interface TimecardActor {
  tenantId: string;
  profileId: string;
}

/** Half-open UTC period; the resolver owns calendar length/start day and DST. */
export interface TimecardPeriod {
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  version: string;
  /** JSON policy snapshot: thresholds, holidays, calendar configuration, etc. */
  rules: Record<string, unknown>;
}

/** Auditable integer-second contribution after clipping to the period. */
export interface TimecardSource {
  kind: 'entry' | 'attendance';
  id: string;
  startsAt: string;
  endsAt: string;
  seconds: number;
}

/** No payroll or jurisdiction policy is built into this interface. */
export interface PeriodRulesResolver {
  periodFor(at: Date, actor: Readonly<TimecardActor>): Promise<TimecardPeriod>;
  classify(
    period: Readonly<TimecardPeriod>,
    sources: readonly Readonly<TimecardSource>[],
    actor: Readonly<TimecardActor>,
  ): Promise<{ regularSeconds: number; overtimeSeconds: number }>;
}

/** Signed correction to a confirmed card, deduplicated by a caller operation key. */
export interface TimecardAdjustmentInput {
  operationId: string;
  regularSeconds: number;
  overtimeSeconds: number;
  reason: string;
}
