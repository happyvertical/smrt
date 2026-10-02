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
import { assertRollupWrite } from './write.js';

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
  @field({ type: 'text' }) status: 'open' | 'confirmed' = 'open';
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
    if (prior?.status === 'confirmed')
      throw new Error(
        'Confirmed timecards are immutable; append an adjustment.',
      );
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
/** Scoped persistence collection; mutations must use PeriodRollupService. */
export class PeriodTimecardCollection extends SmrtCollection<PeriodTimecard> {
  static readonly _itemClass = PeriodTimecard;
}
/** Scoped append-only adjustment collection. */
export class TimecardAdjustmentCollection extends SmrtCollection<TimecardAdjustment> {
  static readonly _itemClass = TimecardAdjustment;
}
