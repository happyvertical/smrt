import { createHash } from 'node:crypto';
import {
  isEmbeddedDatabase,
  isPostgresDatabase,
  withEmbeddedWriteTransaction,
} from '@happyvertical/smrt-core';
import { getTenantId, withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { ServiceTimeEntryCollection } from '../models/service-time-entry.js';
import { clipSource, instant, integer, validatePeriod } from './calculation.js';
import {
  PeriodTimecard,
  PeriodTimecardCollection,
  TimecardAdjustment,
  TimecardAdjustmentCollection,
} from './models.js';
import type {
  PeriodRulesResolver,
  TimecardActor,
  TimecardAdjustmentInput,
  TimecardSource,
} from './types.js';
import { persistRollup } from './write.js';

function identity(parts: string[]): string {
  const bytes = createHash('sha256').update(JSON.stringify(parts)).digest();
  bytes[6] = (bytes[6] & 15) | 80;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function adjustedSeconds(
  base: number,
  rows: TimecardAdjustment[],
  field: 'regularSeconds' | 'overtimeSeconds',
): number {
  const total = rows.reduce(
    (sum, row) => sum + BigInt(integer(row[field], true)),
    BigInt(integer(base)),
  );
  return integer(Number(total));
}

/**
 * Server-side, trusted tenant/person capability. Consumers authorize this scope
 * before construction. Reads and writes reject conflicting ambient tenancy.
 * SQLite and PostgreSQL are supported; policy and payroll remain consumer-owned.
 */
export class PeriodRollupService {
  constructor(
    private readonly db: DatabaseInterface,
    private readonly actor: TimecardActor,
    private readonly resolver: PeriodRulesResolver,
    private readonly options: {
      attendance?: boolean;
      actorProfileId?: string;
    } = {},
  ) {
    if (!actor.tenantId?.trim() || !actor.profileId?.trim())
      throw new Error('Timecards require a trusted tenant/profile actor.');
    this.actor = Object.freeze({
      tenantId: this.identity(actor.tenantId),
      profileId: this.identity(actor.profileId),
    });
    if (options.actorProfileId !== undefined && !options.actorProfileId.trim())
      throw new Error('Actor attribution must be a nonempty profile id.');
    this.options = {
      attendance: options.attendance,
      actorProfileId: this.identity(
        options.actorProfileId ?? this.actor.profileId,
      ),
    };
  }

  private identity(value: string): string {
    if (!isPostgresDatabase(this.db)) return value;
    const hex = value.replace(/[{}-]/g, '').toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(hex))
      throw new Error('PostgreSQL timecard identities must be UUIDs.');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  private scope<T>(run: () => Promise<T>): Promise<T> {
    const active = getTenantId();
    if (active && this.identity(active) !== this.actor.tenantId)
      throw new Error('Timecard actor differs from active tenant.');
    return withTenant({ tenantId: this.actor.tenantId }, run);
  }
  private transact<T>(run: (db: DatabaseInterface) => Promise<T>): Promise<T> {
    return this.scope(() =>
      withEmbeddedWriteTransaction(
        this.db,
        isEmbeddedDatabase(this.db),
        async (db) => {
          if (isPostgresDatabase(db))
            await db.query(
              'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
              JSON.stringify([
                'smrt.rollup',
                this.actor.tenantId,
                this.actor.profileId,
              ]),
            );
          if (this.options.attendance && isPostgresDatabase(db))
            await db.query(
              'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
              JSON.stringify([
                'smrt.attendance',
                this.actor.tenantId,
                this.actor.profileId,
              ]),
            );
          return run(db);
        },
        true,
      ),
    );
  }
  private async card(
    db: DatabaseInterface,
    id: string,
  ): Promise<PeriodTimecard> {
    const collection = await PeriodTimecardCollection.create({ db });
    const [card] = await collection.list({
      where: { ...this.actor, id },
      limit: 1,
    });
    if (!card) throw new Error('Timecard not found in actor scope.');
    return card;
  }
  /** Scoped read on the root executor, including after transaction completion. */
  async get(id: string): Promise<PeriodTimecard> {
    return this.scope(() => this.card(this.db, id));
  }
  /** Rebuild one open card from a consistent transaction-bound source snapshot. */
  async rollup(at: Date): Promise<PeriodTimecard> {
    at = new Date(instant(at));
    const id = await this.transact(async (db) => {
      const period = validatePeriod(
        await this.resolver.periodFor(new Date(at), this.actor),
        at,
      );
      const id = identity([
        'smrt.period',
        this.actor.tenantId,
        this.actor.profileId,
        period.startsAt.toISOString(),
      ]);
      const collection = await PeriodTimecardCollection.create({ db });
      const [prior] = await collection.list({
        where: { ...this.actor, id },
        limit: 1,
      });
      if (prior?.status === 'confirmed')
        throw new Error(
          'Confirmed timecards are immutable; append an adjustment.',
        );
      // A policy change must not create overlapping cards for the same person.
      for (const other of await collection.list({ where: { ...this.actor } })) {
        if (
          other.id !== id &&
          other.startsAt < period.endsAt &&
          other.endsAt > period.startsAt
        )
          throw new Error('Resolver period overlaps an existing timecard.');
      }
      let sources: TimecardSource[] = [];
      let linkedEntryIds = new Set<string>();
      if (this.options.attendance) {
        const { attendanceSources } = await import('./attendance.js');
        ({ sources, linkedEntryIds } = await attendanceSources(
          db,
          this.actor,
          period,
        ));
      }
      const entries = await ServiceTimeEntryCollection.create({ db });
      const evidence = await entries.list({
        where: {
          tenantId: this.actor.tenantId,
          participantProfileId: this.actor.profileId,
          participantKind: 'human',
        },
      });
      const byId = new Map(evidence.map((entry) => [String(entry.id), entry]));
      const approvedRoots = new Set<string>();
      for (const entry of evidence) {
        if (entry.status !== 'approved') continue;
        let linked = linkedEntryIds.has(String(entry.id));
        let ancestor = entry;
        const seen = new Set([String(entry.id)]);
        while (ancestor.correctionOfId) {
          const parentId = ancestor.correctionOfId;
          if (seen.has(parentId))
            throw new Error('Cyclic evidence correction chain.');
          seen.add(parentId);
          const parent = byId.get(parentId);
          if (!parent || parent.status !== 'corrected')
            throw new Error(
              'Correction requires corrected evidence in the same actor scope.',
            );
          linked ||= linkedEntryIds.has(parentId);
          ancestor = parent;
        }
        const rootId = String(ancestor.id);
        if (approvedRoots.has(rootId))
          throw new Error('Ambiguous approved evidence correction chain.');
        approvedRoots.add(rootId);
        if (linked) continue;
        // Duration-only manual evidence belongs to its approval instant. A
        // bounded interval allocates its actual duration by elapsed fraction.
        const start = entry.startedAt ?? entry.approvedAt;
        if (!start)
          throw new Error(
            'Approved evidence needs a start or approval timestamp.',
          );
        const end = entry.endedAt ?? start;
        const source = clipSource(
          {
            kind: 'entry',
            id: String(entry.id),
            startsAt: new Date(instant(start)).toISOString(),
            endsAt: new Date(instant(end)).toISOString(),
            seconds: integer(entry.durationSeconds),
          },
          period,
        );
        if (source?.seconds) sources.push(source);
      }
      sources.sort(
        (a, b) =>
          a.startsAt.localeCompare(b.startsAt) ||
          a.kind.localeCompare(b.kind) ||
          a.id.localeCompare(b.id),
      );
      const totalSeconds = sources.reduce(
        (sum, source) => integer(sum + source.seconds),
        0,
      );
      // Resolver receives detached snapshots so it cannot alter persisted evidence.
      const classified = await this.resolver.classify(
        structuredClone(period),
        structuredClone(sources),
        this.actor,
      );
      const regularSeconds = integer(classified?.regularSeconds);
      const overtimeSeconds = integer(classified?.overtimeSeconds);
      if (integer(regularSeconds + overtimeSeconds) !== totalSeconds)
        throw new Error('Resolver classification must conserve total seconds.');
      const card =
        prior ??
        (await new PeriodTimecard({ db, id, _skipLoad: true }).initialize());
      if (!prior) card.requireInsertOnSave();
      Object.assign(card, this.actor, {
        startsAt: period.startsAt,
        endsAt: period.endsAt,
        timezone: period.timezone,
        rulesVersion: period.version,
        rulesSnapshot: JSON.stringify(period.rules),
        sourceSnapshot: JSON.stringify(sources),
        regularSeconds,
        overtimeSeconds,
        totalSeconds,
      });
      await persistRollup(card);
      return id;
    });
    return this.get(id);
  }
  /** Confirm the current snapshot; repeated confirmation is idempotent. */
  async confirm(id: string): Promise<PeriodTimecard> {
    await this.transact(async (db) => {
      const card = await this.card(db, id);
      if (card.status === 'confirmed') return;
      card.status = 'confirmed';
      card.confirmedAt = new Date();
      card.confirmedByProfileId = this.options.actorProfileId!;
      await persistRollup(card);
    });
    return this.get(id);
  }
  /** Append a correction. An operation key retry must have exactly the same payload. */
  async adjust(
    id: string,
    input: TimecardAdjustmentInput,
  ): Promise<TimecardAdjustment> {
    id = this.identity(id);
    input = {
      operationId: input.operationId,
      reason: input.reason,
      regularSeconds: input.regularSeconds,
      overtimeSeconds: input.overtimeSeconds,
    };
    integer(input.regularSeconds, true);
    integer(input.overtimeSeconds, true);
    if (!input.operationId?.trim() || !input.reason?.trim())
      throw new Error('Adjustment requires an operationId and reason.');
    const adjustmentId = identity([
      'smrt.adjustment',
      this.actor.tenantId,
      this.actor.profileId,
      id,
      input.operationId,
    ]);
    await this.transact(async (db) => {
      const card = await this.card(db, id);
      if (card.status !== 'confirmed')
        throw new Error('Adjustments require a confirmed timecard.');
      const collection = await TimecardAdjustmentCollection.create({ db });
      const rows = await collection.list({
        where: { ...this.actor, timecardId: id },
      });
      const prior = rows.find((row) => row.id === adjustmentId);
      if (prior) {
        if (
          prior.regularSeconds !== input.regularSeconds ||
          prior.overtimeSeconds !== input.overtimeSeconds ||
          prior.reason !== input.reason ||
          prior.actorProfileId !== this.options.actorProfileId
        )
          throw new Error(
            'Adjustment operationId reused with a different payload.',
          );
        return;
      }
      const regular = adjustedSeconds(
        card.regularSeconds,
        rows,
        'regularSeconds',
      );
      const overtime = adjustedSeconds(
        card.overtimeSeconds,
        rows,
        'overtimeSeconds',
      );
      integer(
        integer(regular + input.regularSeconds) +
          integer(overtime + input.overtimeSeconds),
      );
      const adjustment = await new TimecardAdjustment({
        db,
        id: adjustmentId,
        _skipLoad: true,
      }).initialize();
      Object.assign(adjustment, this.actor, {
        timecardId: id,
        actorProfileId: this.options.actorProfileId!,
        ...input,
      });
      await persistRollup(adjustment);
    });
    return this.scope(async () => {
      const collection = await TimecardAdjustmentCollection.create({
        db: this.db,
      });
      const [row] = await collection.list({
        where: { ...this.actor, id: adjustmentId },
        limit: 1,
      });
      if (!row) throw new Error('Committed adjustment disappeared.');
      return row;
    });
  }
  /** Effective totals combine the frozen base with append-only corrections. */
  async totals(id: string): Promise<{
    regularSeconds: number;
    overtimeSeconds: number;
    totalSeconds: number;
  }> {
    return this.transact(async (db) => {
      const card = await this.card(db, id);
      const collection = await TimecardAdjustmentCollection.create({ db });
      const rows = await collection.list({
        where: { ...this.actor, timecardId: id },
      });
      const regularSeconds = adjustedSeconds(
        card.regularSeconds,
        rows,
        'regularSeconds',
      );
      const overtimeSeconds = adjustedSeconds(
        card.overtimeSeconds,
        rows,
        'overtimeSeconds',
      );
      return {
        regularSeconds,
        overtimeSeconds,
        totalSeconds: integer(regularSeconds + overtimeSeconds),
      };
    });
  }
}
