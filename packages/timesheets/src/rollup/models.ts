import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { TimecardSource } from './types.js';
import { assertRollupWrite, isReopenWrite } from './write.js';

/** `open` is the draft state; `submitted` is optional (see `PeriodRollupService`). */
export type TimecardStatus = 'open' | 'submitted' | 'confirmed';

/** One person's immutable-on-confirmation period snapshot, in integer seconds. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'period_timecards',
  sensitive: true,
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
export class PeriodTimecard extends SmrtObject {
  @tenantId() tenantId = '';
  @crossPackageRef('@happyvertical/smrt-profiles:Profile', {
    onDelete: 'RESTRICT',
  })
  profileId = '';
  startsAt: Date = new Date(0);
  endsAt: Date = new Date(0);
  timezone = '';
  rulesVersion = '';
  @field({ type: 'text' }) rulesSnapshot = '{}';
  @field({ type: 'text' }) sourceSnapshot = '[]';
  regularSeconds = 0;
  overtimeSeconds = 0;
  totalSeconds = 0;
  @field({ type: 'text' }) status: TimecardStatus = 'open';
  /** Set by `submit()`; cleared when the card is reopened. */
  submittedAt: Date | null = null;
  @crossPackageRef('@happyvertical/smrt-profiles:Profile', {
    nullable: true,
    onDelete: 'RESTRICT',
  })
  submittedByProfileId: string | null = null;
  confirmedAt: Date | null = null;
  @crossPackageRef('@happyvertical/smrt-profiles:Profile', {
    nullable: true,
    onDelete: 'RESTRICT',
  })
  confirmedByProfileId: string | null = null;

  /** Return a detached source snapshot; corrupt persisted JSON fails closed. */
  getSources(): TimecardSource[] {
    const result: unknown = JSON.parse(this.sourceSnapshot);
    if (!Array.isArray(result))
      throw new Error('Invalid timecard source snapshot.');
    return result as TimecardSource[];
  }
  /** Return the consumer policy frozen with this rollup. */
  getRules(): Record<string, unknown> {
    const result: unknown = JSON.parse(this.rulesSnapshot);
    if (!result || typeof result !== 'object' || Array.isArray(result))
      throw new Error('Invalid timecard rules snapshot.');
    return result as Record<string, unknown>;
  }
  override async save(): Promise<this> {
    assertRollupWrite(this);
    const prior = this.id
      ? await this.db.get(this.tableName, { id: this.id })
      : null;
    if (prior?.status === 'confirmed' && !isReopenWrite(this))
      throw new Error(
        'Confirmed timecards are immutable; append an adjustment.',
      );
    if (prior?.status === 'submitted' && !isReopenWrite(this)) {
      // A submitted card only moves forward to confirmed (or back via reopen).
      if (this.status !== 'confirmed' && this.status !== 'submitted')
        throw new Error(
          'Submitted timecards can only be confirmed or reopened.',
        );
    }
    if (
      prior &&
      (prior.tenant_id !== this.tenantId ||
        prior.profile_id !== this.profileId ||
        new Date(prior.starts_at as string).getTime() !==
          this.startsAt.getTime())
    )
      throw new Error('Timecard identity is immutable.');
    return (await super.save()) as this;
  }
  override async delete(): Promise<void> {
    throw new Error('Timecard history cannot be deleted.');
  }
}

/** Attributed append-only signed seconds; the confirmed base card never changes. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'timecard_adjustments',
  sensitive: true,
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
export class TimecardAdjustment extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey(PeriodTimecard, { onDelete: 'RESTRICT' }) timecardId = '';
  @crossPackageRef('@happyvertical/smrt-profiles:Profile', {
    onDelete: 'RESTRICT',
  })
  profileId = '';
  @crossPackageRef('@happyvertical/smrt-profiles:Profile', {
    onDelete: 'RESTRICT',
  })
  actorProfileId = '';
  operationId = '';
  regularSeconds = 0;
  overtimeSeconds = 0;
  reason = '';
  override async save(): Promise<this> {
    assertRollupWrite(this);
    if (this.id && (await this.db.get(this.tableName, { id: this.id })))
      throw new Error('Timecard adjustments are append-only.');
    this.requireInsertOnSave();
    return (await super.save()) as this;
  }
  override async delete(): Promise<void> {
    throw new Error('Timecard adjustments cannot be deleted.');
  }
}
/**
 * Append-only audit row for one reopening of a submitted or confirmed card: who
 * reopened whose period, why, and the totals it had at that moment (base,
 * adjustments and effective, in integer seconds). Written only by
 * `PeriodRollupService.reopen()` in the same transaction as the status change.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'timecard_reopenings',
  sensitive: true,
  indexes: [
    {
      name: 'timecard_reopenings_card_idx',
      columns: ['tenantId', 'timecardId'],
    },
  ],
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
export class TimecardReopening extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey(PeriodTimecard, { onDelete: 'RESTRICT' }) timecardId = '';
  @crossPackageRef('@happyvertical/smrt-profiles:Profile', {
    onDelete: 'RESTRICT',
  })
  profileId = '';
  @crossPackageRef('@happyvertical/smrt-profiles:Profile', {
    onDelete: 'RESTRICT',
  })
  actorProfileId = '';
  operationId = '';
  @field({ type: 'text' }) fromStatus: TimecardStatus = 'confirmed';
  @field({ type: 'text' }) reason = '';
  /** JSON: base/adjustment/effective seconds, confirmation and submission attribution. */
  @field({ type: 'text' }) previousState = '{}';
  /** The totals and attribution the card had when it was reopened. */
  getPrevious<T = Record<string, unknown>>(): T {
    const result: unknown = JSON.parse(this.previousState);
    if (!result || typeof result !== 'object' || Array.isArray(result))
      throw new Error('Invalid timecard reopening snapshot.');
    return result as T;
  }
  override async save(): Promise<this> {
    assertRollupWrite(this);
    if (this.id && (await this.db.get(this.tableName, { id: this.id })))
      throw new Error('Timecard reopenings are append-only.');
    if (!this.reason?.trim() || !this.operationId?.trim())
      throw new Error('Reopening requires an operationId and reason.');
    this.requireInsertOnSave();
    return (await super.save()) as this;
  }
  override async delete(): Promise<void> {
    throw new Error('Timecard reopenings cannot be deleted.');
  }
}
/** Scoped persistence collection; mutations must use PeriodRollupService. */
export class PeriodTimecardCollection extends SmrtCollection<PeriodTimecard> {
  static readonly _itemClass = PeriodTimecard;
}
/** Scoped append-only adjustment collection. */
export class TimecardAdjustmentCollection extends SmrtCollection<TimecardAdjustment> {
  static readonly _itemClass = TimecardAdjustment;
}
/** Scoped append-only reopening ledger. */
export class TimecardReopeningCollection extends SmrtCollection<TimecardReopening> {
  static readonly _itemClass = TimecardReopening;
}
