import {
  isEmbeddedDatabase,
  isPostgresDatabase,
  withEmbeddedWriteTransaction,
} from '@happyvertical/smrt-core';
import { getTenantId, withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { ServiceTimeEntryCollection } from '../models/service-time-entry.js';
import {
  AttendanceBreakCollection,
  AttendancePunch,
  AttendancePunchCollection,
  AttendanceReplayCollection,
  type AttendanceReplayOutcome,
} from './models.js';

export type { AttendanceReplayOutcome } from './models.js';

/** Resolve these identifiers from the authenticated session, never from tap input. */
export interface AttendanceActor {
  tenantId: string;
  profileId: string;
}
/** Explicit work attribution for a closed punch's draft evidence entry. */
export interface AttendanceWork {
  workRefType: string;
  workRefId: string;
  description: string;
}
/** Offline command with a durable client-generated identifier and device timestamp. */
export interface AttendanceTap {
  clientId: string;
  at: string;
  action: 'punchIn' | 'punchOut' | 'startBreak' | 'endBreak';
  paid?: boolean;
  work?: AttendanceWork;
}

/** Expected state conflict, distinct from retryable database failures. */
export class AttendanceConflict extends Error {}

type Context = {
  db: DatabaseInterface;
  punches: AttendancePunchCollection;
  breaks: AttendanceBreakCollection;
  replays: AttendanceReplayCollection;
};

/**
 * Attendance mutations bound to a trusted tenant/profile. Applications authorize
 * the actor before constructing this service. Each transition is atomic; all
 * participating collections use the transaction executor. PostgreSQL serializes
 * this actor with an advisory lock; embedded adapters serialize writers.
 */
export class AttendanceService {
  constructor(
    private readonly db: DatabaseInterface,
    private readonly actor: AttendanceActor,
  ) {
    if (!actor.tenantId || !actor.profileId)
      throw new Error('Attendance requires a trusted tenant/profile actor.');
    this.actor = {
      tenantId: this.identity(actor.tenantId),
      profileId: this.identity(actor.profileId),
    };
  }

  private identity(value: string): string {
    if (!isPostgresDatabase(this.db)) return value;
    const hex = value.replace(/[{}-]/g, '').toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(hex))
      throw new Error('PostgreSQL attendance identities must be UUIDs.');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  private async transact<T>(
    operation: (context: Context) => Promise<T>,
  ): Promise<T> {
    const current = getTenantId();
    if (current && this.identity(current) !== this.actor.tenantId)
      throw new Error('Attendance actor differs from active tenant.');
    return withTenant({ tenantId: this.actor.tenantId }, async () => {
      const result = await withEmbeddedWriteTransaction(
        this.db,
        isEmbeddedDatabase(this.db),
        async (db) => {
          if (isPostgresDatabase(db))
            await db.query(
              'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
              JSON.stringify([
                'smrt.attendance',
                this.actor.tenantId,
                this.actor.profileId,
              ]),
            );
          return operation({
            db,
            punches: await AttendancePunchCollection.create({ db }),
            breaks: await AttendanceBreakCollection.create({ db }),
            replays: await AttendanceReplayCollection.create({ db }),
          });
        },
        true,
      );
      if (result instanceof AttendancePunch) {
        const punches = await AttendancePunchCollection.create({ db: this.db });
        const [fresh] = await punches.list({
          where: { ...this.actor, id: result.id },
          limit: 1,
        });
        if (!fresh) throw new Error('Committed attendance punch disappeared.');
        return fresh as T;
      }
      return result;
    });
  }

  private date(at: Date): Date {
    if (!(at instanceof Date) || !Number.isFinite(at.getTime()))
      throw new AttendanceConflict(
        'Attendance timestamps must be valid dates.',
      );
    return at;
  }

  private async open(tx: Context): Promise<AttendancePunch> {
    const [punch] = await tx.punches.list({
      where: { ...this.actor, endedAt: null },
      limit: 1,
    });
    if (!punch) throw new AttendanceConflict('No open punch.');
    return punch;
  }

  private async chronological(tx: Context, at: Date): Promise<void> {
    const open = await tx.punches.list({
      where: { ...this.actor, endedAt: null },
      limit: 1,
    });
    const rows = open.length
      ? open
      : await tx.punches.list({
          where: { ...this.actor },
          orderBy: 'ended_at DESC',
          limit: 1,
        });
    if (!rows.length) return;
    const punch = rows[0];
    const breaks = await tx.breaks.list({
      where: { tenantId: this.actor.tenantId, punchId: punch.id },
    });
    const latest = Math.max(
      punch.startedAt.getTime(),
      punch.endedAt?.getTime() ?? 0,
      ...breaks.flatMap((b) => [
        b.startedAt.getTime(),
        b.endedAt?.getTime() ?? 0,
      ]),
    );
    if (at.getTime() < latest)
      throw new AttendanceConflict(
        'Tap predates committed attendance; manual review required.',
      );
  }

  /** Open one punch; the database unique slot also protects direct model writers. */
  async punchIn(at = new Date()): Promise<AttendancePunch> {
    return this.transact((tx) => this.transition(tx, 'punchIn', this.date(at)));
  }
  /** Close the punch and any active break; optionally create linked draft evidence. */
  async punchOut(at: Date, work?: AttendanceWork): Promise<AttendancePunch> {
    return this.transact((tx) =>
      this.transition(tx, 'punchOut', this.date(at), false, work),
    );
  }
  /** Begin a break; paid defaults false and must be explicitly configured by the caller. */
  async startBreak(at: Date, paid = false): Promise<AttendancePunch> {
    return this.transact((tx) =>
      this.transition(tx, 'startBreak', this.date(at), paid),
    );
  }
  /** End the current break. */
  async endBreak(at: Date): Promise<AttendancePunch> {
    return this.transact((tx) =>
      this.transition(tx, 'endBreak', this.date(at)),
    );
  }

  private async transition(
    tx: Context,
    action: AttendanceTap['action'],
    at: Date,
    paid = false,
    work?: AttendanceWork,
  ): Promise<AttendancePunch> {
    await this.chronological(tx, at);
    if (action === 'punchIn') {
      if (
        (
          await tx.punches.list({
            where: { ...this.actor, endedAt: null },
            limit: 1,
          })
        ).length
      )
        throw new AttendanceConflict('A punch is already open.');
      return tx.punches.create({
        ...this.actor,
        startedAt: at,
        _insertOnly: true,
      });
    }
    const punch = await this.open(tx);
    const breaks = await tx.breaks.list({
      where: { tenantId: this.actor.tenantId, punchId: punch.id },
    });
    const active = breaks.find((b) => !b.endedAt);
    if (action === 'startBreak') {
      if (active) throw new AttendanceConflict('A break is already open.');
      if (typeof paid !== 'boolean')
        throw new AttendanceConflict('paid must be boolean.');
      await tx.breaks.create({
        tenantId: this.actor.tenantId,
        punchId: punch.id ?? undefined,
        startedAt: at,
        paid,
        _insertOnly: true,
      });
      return punch;
    }
    if (action !== 'endBreak' && action !== 'punchOut')
      throw new AttendanceConflict('Unknown attendance action.');
    if (action === 'endBreak' && !active)
      throw new AttendanceConflict('No open break.');
    if (action === 'punchOut' && work) {
      this.validateWork(work);
      const unpaid = breaks
        .filter((b) => !b.paid)
        .reduce(
          (sum, b) =>
            sum + ((b.endedAt ?? at).getTime() - b.startedAt.getTime()) / 1000,
          0,
        );
      if (
        Math.round(
          (at.getTime() - punch.startedAt.getTime()) / 1000 - unpaid,
        ) <= 0
      )
        throw new AttendanceConflict(
          'Only closed punches with positive duration can produce service evidence.',
        );
    }
    if (active) {
      active.endedAt = at;
      await active.save();
    }
    if (action === 'endBreak') return punch;
    punch.endedAt = at;
    const unpaidSeconds = breaks
      .filter((b) => !b.paid)
      .reduce(
        (sum, b) => sum + (b.endedAt!.getTime() - b.startedAt.getTime()) / 1000,
        0,
      );
    punch.unpaidBreakSeconds = Math.round(unpaidSeconds);
    punch.durationSeconds = Math.round(
      (at.getTime() - punch.startedAt.getTime()) / 1000 - unpaidSeconds,
    );
    await punch.save();
    if (work) await this.link(tx, punch, work);
    return punch;
  }

  private validateWork(work: AttendanceWork): void {
    if (
      !work ||
      typeof work.workRefType !== 'string' ||
      !work.workRefType ||
      typeof work.workRefId !== 'string' ||
      !work.workRefId ||
      typeof work.description !== 'string'
    )
      throw new AttendanceConflict(
        'A complete work reference and description are required.',
      );
  }

  private async link(
    tx: Context,
    punch: AttendancePunch,
    work: AttendanceWork,
  ): Promise<void> {
    this.validateWork(work);
    if (!punch.endedAt || punch.durationSeconds <= 0)
      throw new AttendanceConflict(
        'Only closed punches with positive duration can produce service evidence.',
      );
    const entries = await ServiceTimeEntryCollection.create({ db: tx.db });
    if (punch.serviceTimeEntryId) {
      const [existing] = await entries.list({
        where: { id: punch.serviceTimeEntryId, tenantId: this.actor.tenantId },
        limit: 1,
      });
      if (
        !existing ||
        existing.workRefType !== work.workRefType ||
        existing.workRefId !== work.workRefId ||
        existing.description !== work.description
      )
        throw new AttendanceConflict('Punch already linked to different work.');
      return;
    }
    const entry = await entries.create({
      tenantId: this.actor.tenantId,
      participantKind: 'human',
      participantProfileId: this.actor.profileId,
      workRefType: work.workRefType,
      workRefId: work.workRefId,
      description: work.description,
      source: 'timer',
      startedAt: punch.startedAt,
      endedAt: punch.endedAt,
      durationSeconds: punch.durationSeconds,
      status: 'draft',
      metadata: JSON.stringify({ attendancePunchId: punch.id }),
      _insertOnly: true,
    });
    if (!entry.id) throw new Error('Saved service entry has no id.');
    punch.serviceTimeEntryId = entry.id;
    await punch.save();
  }

  /** Idempotently link a closed, owned punch to draft service evidence. */
  async linkServiceTimeEntry(
    punchId: string,
    work: AttendanceWork,
  ): Promise<AttendancePunch> {
    return this.transact(async (tx) => {
      const [punch] = await tx.punches.list({
        where: { ...this.actor, id: punchId },
        limit: 1,
      });
      if (!punch) throw new AttendanceConflict('Punch not found for actor.');
      await this.link(tx, punch, work);
      return punch;
    });
  }

  /** Close at startedAt + maxOpenSeconds once due, flagging the punch for review. */
  async autoClose(
    now: Date,
    maxOpenSeconds: number,
  ): Promise<AttendancePunch | null> {
    this.date(now);
    if (!Number.isSafeInteger(maxOpenSeconds) || maxOpenSeconds <= 0)
      throw new AttendanceConflict(
        'maxOpenSeconds must be a positive integer.',
      );
    return this.transact(async (tx) => {
      const [punch] = await tx.punches.list({
        where: { ...this.actor, endedAt: null },
        limit: 1,
      });
      if (!punch) return null;
      const deadline = new Date(
        punch.startedAt.getTime() + maxOpenSeconds * 1000,
      );
      if (deadline > now) return null;
      // Do not truncate a later committed break. The conflict requires manual review.
      const closed = await this.transition(tx, 'punchOut', deadline);
      closed.reviewRequired = true;
      await closed.save();
      return closed;
    });
  }

  /**
   * Replay device timestamps in order (ties use clientId). Committed attendance
   * wins: stale/state-conflicting taps get durable refusals; identical retries
   * return the same outcome, changed payloads using a key are rejected. A
   * database failure rolls back its tap and receipt and remains retryable.
   */
  async replay(
    taps: readonly AttendanceTap[],
  ): Promise<AttendanceReplayOutcome[]> {
    for (const tap of taps) {
      if (
        !tap ||
        typeof tap.at !== 'string' ||
        typeof tap.clientId !== 'string' ||
        !tap.clientId ||
        !['punchIn', 'punchOut', 'startBreak', 'endBreak'].includes(tap.action)
      )
        throw new AttendanceConflict('Malformed attendance tap.');
      this.date(new Date(tap.at));
      if (tap.work !== undefined) this.validateWork(tap.work);
      if (tap.paid !== undefined && typeof tap.paid !== 'boolean')
        throw new AttendanceConflict('paid must be boolean.');
    }
    const ordered = [...taps].sort(
      (a, b) =>
        Date.parse(a.at) - Date.parse(b.at) ||
        (a.clientId < b.clientId ? -1 : a.clientId > b.clientId ? 1 : 0),
    );
    const outcomes: AttendanceReplayOutcome[] = [];
    for (const tap of ordered)
      outcomes.push(
        await this.transact(async (tx) => {
          const replayKey = JSON.stringify([
            this.actor.tenantId,
            this.actor.profileId,
            tap.clientId,
          ]);
          const content = JSON.stringify([
            tap.action,
            new Date(tap.at).toISOString(),
            tap.paid ?? false,
            tap.work?.workRefType ?? null,
            tap.work?.workRefId ?? null,
            tap.work?.description ?? null,
          ]);
          const [receipt] = await tx.replays.list({
            where: { tenantId: this.actor.tenantId, replayKey },
            limit: 1,
          });
          if (receipt) {
            if (receipt.content !== content)
              throw new AttendanceConflict(
                'Client id reused with different content.',
              );
            const outcome = receipt.getOutcome();
            if (outcome.clientId !== tap.clientId)
              throw new Error(
                'Stored attendance receipt belongs to another client id.',
              );
            return outcome;
          }
          let outcome: AttendanceReplayOutcome;
          try {
            // Domain refusals are validated before the first write. Adapters with
            // savepoints isolate the tap; every failure remains in the outer atomic scope.
            // Any database failure escapes and rolls back the entire transaction.
            outcome = await withEmbeddedWriteTransaction(
              tx.db,
              isEmbeddedDatabase(tx.db),
              async (db) => {
                const inner = {
                  db,
                  punches: await AttendancePunchCollection.create({ db }),
                  breaks: await AttendanceBreakCollection.create({ db }),
                  replays: tx.replays,
                };
                const punch = await this.transition(
                  inner,
                  tap.action,
                  new Date(tap.at),
                  tap.paid,
                  tap.work,
                );
                punch.recordedOffline = true;
                punch.reviewRequired = true;
                await punch.save();
                return { clientId: tap.clientId, punchId: punch.id! };
              },
              true,
            );
          } catch (error) {
            if (!(error instanceof AttendanceConflict)) throw error;
            outcome = { clientId: tap.clientId, error: error.message };
          }
          await tx.replays.create({
            tenantId: this.actor.tenantId,
            replayKey,
            content,
            outcome: JSON.stringify(outcome),
            _insertOnly: true,
          });
          return outcome;
        }),
      );
    return outcomes;
  }
}
