import {
  isEmbeddedDatabase,
  isPostgresDatabase,
  withEmbeddedWriteTransaction,
} from '@happyvertical/smrt-core';
import { getTenantId, withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { parseTimesheetJson } from '../models/json.js';
import { ServiceTimeEntryCollection } from '../models/service-time-entry.js';
import {
  type AttendanceActor,
  type AttendanceBreakOptions,
  AttendanceConflict,
  type AttendanceContext,
  type AttendanceDeviceRef,
  type AttendancePunchOptions,
  type AttendanceRefusalCode,
  type AttendanceWork,
  attendanceIdentity,
  attendanceLabel,
  attendanceProvenance,
  validateAttendanceWork,
} from './context.js';
import {
  AttendanceBreakCollection,
  AttendancePunch,
  AttendancePunchCollection,
  AttendanceReplayCollection,
  type AttendanceReplayOutcome,
  AttendanceSegment,
  AttendanceSegmentCollection,
} from './models.js';
import {
  beginSegment,
  closeOpenSegment,
  continueSegment,
  endSegment,
  listSegments,
  openSegment,
  replaceSegment,
} from './segments.js';
import { persistAutoClose } from './write.js';

/** Whether stored evidence metadata carries this work's task reference and kind. */
function sameAttribution(metadata: string, work: AttendanceWork): boolean {
  const stored = parseTimesheetJson<Record<string, unknown>>(metadata, {});
  return (
    (stored.taskRefType ?? '') === (work.taskRefType ?? '') &&
    (stored.taskRefId ?? '') === (work.taskRefId ?? '') &&
    (stored.kind ?? '') === (work.kind ?? '')
  );
}

export {
  type AttendanceActor,
  type AttendanceBreakOptions,
  AttendanceConflict,
  type AttendanceContext,
  type AttendanceDeviceRef,
  type AttendancePunchOptions,
  type AttendanceRefusalCode,
  type AttendanceWork,
  validateAttendanceWork,
} from './context.js';
export type { AttendanceReplayOutcome } from './models.js';
export * from './segments.js';

/** Offline command with a durable client-generated identifier and device timestamp. */
export interface AttendanceTap {
  clientId: string;
  at: string;
  action: AttendanceTapAction;
  paid?: boolean;
  /** Required by `startWork` and `switchWork`; also links evidence on `punchOut`. */
  work?: AttendanceWork;
  /** Recorded on the punch by `punchIn`; hashed with the tap. */
  source?: string;
  /** Recorded on the punch by `punchIn`; hashed with the tap. */
  device?: AttendanceDeviceRef;
  /** Recorded on the break by `startBreak`; hashed with the tap. */
  kind?: string;
}

/** Punch and break actions plus the work-segment actions (`stopWork` is "pause"). */
export type AttendanceTapAction =
  | 'punchIn'
  | 'punchOut'
  | 'startBreak'
  | 'endBreak'
  | 'startWork'
  | 'switchWork'
  | 'stopWork'
  | 'resumeWork';

const TAP_ACTIONS: readonly string[] = [
  'punchIn',
  'punchOut',
  'startBreak',
  'endBreak',
  'startWork',
  'switchWork',
  'stopWork',
  'resumeWork',
];

/** What a time policy sees for one tap that has not been replayed yet. */
export interface AttendanceTimeInput {
  /** The tap exactly as sent. */
  tap: AttendanceTap;
  /** The tap's device time. */
  deviceAt: Date;
  /** When the server received the batch. */
  serverNow: Date;
  /** `serverNow - deviceAt` in milliseconds: how long the tap waited. */
  waitedMs: number;
  /** The trusted actor the tap replays for. */
  actor: AttendanceActor;
}

/** The effective time a policy chose, and whether a person should look at it. */
export interface AttendanceResolvedTime {
  at: Date;
  /**
   * Whether a person should review the result. Applies to the punch (default
   * true when omitted) and, when true, the resulting work segment.
   */
  reviewRequired?: boolean;
  /** Whether the punch is stored as recorded offline. Default true when omitted. */
  recordedOffline?: boolean;
}

/** Why a consumer refuses or rewrites the stored reason of a refused tap. */
export interface AttendanceRefusal {
  code: AttendanceRefusalCode;
  /** Replaces the default message when given. */
  message?: string;
}

/** A resolved auto-close deadline and, optionally, why the punch closed then. */
export interface AttendanceAutoCloseDecision {
  deadline: Date;
  /** Recorded as `autoCloseReason` (1 to 200 characters); defaults to `deadline`. */
  reason?: string;
}

/**
 * Fixed maximum open seconds, or a per-punch resolver returning the deadline
 * (a Date or a decision) or null to leave the punch open.
 */
export type AttendanceAutoCloseDeadline =
  | number
  | ((
      punch: AttendancePunch,
    ) =>
      | Date
      | AttendanceAutoCloseDecision
      | null
      | undefined
      | Promise<Date | AttendanceAutoCloseDecision | null | undefined>);

export interface AttendanceReplayOptions {
  /**
   * Choose each tap's effective time (for example the device time inside a
   * window, else the server arrival time). The receipt still hashes the tap as
   * sent, so retries with the same clientId match; the resolved time is what is
   * stored. Called once per tap that has no receipt yet, inside its transaction.
   */
  resolveAt?: (
    input: AttendanceTimeInput,
  ) => AttendanceResolvedTime | Promise<AttendanceResolvedTime>;
  /** Clock for `serverNow`; defaults to `new Date()` per tap. */
  now?: () => Date;
  /**
   * Name the stored code (and optionally message) of a refused tap. Without it,
   * the refusal's own `AttendanceConflict.code` is stored.
   */
  refusal?: (
    tap: AttendanceTap,
    error: AttendanceConflict,
  ) => AttendanceRefusal | undefined | void;
}

type Context = AttendanceContext;

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
    return attendanceIdentity(this.db, value);
  }

  /**
   * Run `operation` in the actor's serialized attendance transaction. The
   * context's collections share the executor, so corrections and replay can
   * compose several attendance mutations (with the segment helpers) atomically.
   * Results that are punches or segments are re-read after commit.
   */
  async withTransaction<T>(
    operation: (context: AttendanceContext) => Promise<T>,
  ): Promise<T> {
    return this.transact(operation);
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
            segments: await AttendanceSegmentCollection.create({ db }),
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
      if (result instanceof AttendanceSegment) {
        const segments = await AttendanceSegmentCollection.create({
          db: this.db,
        });
        const [fresh] = await segments.list({
          where: { tenantId: this.actor.tenantId, id: result.id },
          limit: 1,
        });
        if (!fresh)
          throw new Error('Committed attendance segment disappeared.');
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
    if (!punch) throw new AttendanceConflict('No open punch.', 'no_open_punch');
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
    const segments = await tx.segments.list({
      where: { tenantId: this.actor.tenantId, punchId: punch.id },
    });
    const latest = Math.max(
      punch.startedAt.getTime(),
      ...segments.flatMap((g) => [
        g.startedAt.getTime(),
        g.endedAt?.getTime() ?? 0,
      ]),
      punch.endedAt?.getTime() ?? 0,
      ...breaks.flatMap((b) => [
        b.startedAt.getTime(),
        b.endedAt?.getTime() ?? 0,
      ]),
    );
    if (at.getTime() < latest)
      throw new AttendanceConflict(
        'Tap predates committed attendance; manual review required.',
        'predates_committed',
      );
  }

  /** Open one punch; the database unique slot also protects direct model writers. */
  async punchIn(
    at = new Date(),
    options?: AttendancePunchOptions,
  ): Promise<AttendancePunch> {
    const meta = attendanceProvenance(options);
    return this.transact((tx) =>
      this.transition(tx, 'punchIn', this.date(at), false, undefined, false, {
        ...meta,
        kind: '',
      }),
    );
  }
  /** Close the punch and any active break; optionally create linked draft evidence. */
  async punchOut(at: Date, work?: AttendanceWork): Promise<AttendancePunch> {
    return this.transact((tx) =>
      this.transition(tx, 'punchOut', this.date(at), false, work),
    );
  }
  /** Begin a break; paid defaults false and must be explicitly configured by the caller. */
  async startBreak(
    at: Date,
    paid = false,
    options?: AttendanceBreakOptions,
  ): Promise<AttendancePunch> {
    const kind = attendanceLabel(options?.kind, 'kind');
    return this.transact((tx) =>
      this.transition(tx, 'startBreak', this.date(at), paid, undefined, false, {
        ...attendanceProvenance(),
        kind,
      }),
    );
  }
  /**
   * End the current break. With `{ resumeWork: true }` the work interrupted by
   * `startBreak` resumes at the same instant, atomically with the break end.
   */
  async endBreak(
    at: Date,
    options?: { resumeWork?: boolean },
  ): Promise<AttendancePunch> {
    return this.transact((tx) =>
      this.transition(
        tx,
        'endBreak',
        this.date(at),
        false,
        undefined,
        options?.resumeWork,
      ),
    );
  }

  /** Open a work segment in the open punch; refuses during a break or while one is open. */
  async startWork(at: Date, work: AttendanceWork): Promise<AttendanceSegment> {
    return this.transact(async (tx) => {
      validateAttendanceWork(work);
      await this.chronological(tx, this.date(at));
      return beginSegment(tx, await this.open(tx), at, work);
    });
  }
  /** Atomically close the open segment and open the next one at `at`. */
  async switchWork(at: Date, work: AttendanceWork): Promise<AttendanceSegment> {
    return this.transact(async (tx) => {
      validateAttendanceWork(work);
      await this.chronological(tx, this.date(at));
      return replaceSegment(tx, await this.open(tx), at, work);
    });
  }
  /** Close the open segment without starting another. */
  async stopWork(at: Date): Promise<AttendanceSegment> {
    return this.transact(async (tx) => {
      await this.chronological(tx, this.date(at));
      return endSegment(tx, await this.open(tx), at);
    });
  }
  /** Reopen the work a break interrupted (the latest segment must have closed on `startBreak`). */
  async resumeWork(at: Date): Promise<AttendanceSegment> {
    return this.transact(async (tx) => {
      await this.chronological(tx, this.date(at));
      return continueSegment(tx, await this.open(tx), at);
    });
  }
  /** The open work segment of the actor's open punch, or null. */
  async currentWork(): Promise<AttendanceSegment | null> {
    return this.transact(async (tx) => {
      const [punch] = await tx.punches.list({
        where: { ...this.actor, endedAt: null },
        limit: 1,
      });
      return punch ? openSegment(tx, punch) : null;
    });
  }
  /** Work segments of one of the actor's punches, oldest first. */
  async segments(punchId: string): Promise<AttendanceSegment[]> {
    return this.transact(async (tx) => {
      const [punch] = await tx.punches.list({
        where: { ...this.actor, id: punchId },
        limit: 1,
      });
      if (!punch) throw new AttendanceConflict('Punch not found for actor.');
      return listSegments(tx, punch);
    });
  }

  private async transition(
    tx: Context,
    action: AttendanceTap['action'],
    at: Date,
    paid = false,
    work?: AttendanceWork,
    resumeWork = false,
    meta: ReturnType<typeof attendanceProvenance> & { kind: string } = {
      ...attendanceProvenance(),
      kind: '',
    },
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
        throw new AttendanceConflict('A punch is already open.', 'punch_open');
      return tx.punches.create({
        ...this.actor,
        startedAt: at,
        source: meta.source,
        deviceRefType: meta.deviceRefType,
        deviceRefId: meta.deviceRefId,
        _insertOnly: true,
      });
    }
    const punch = await this.open(tx);
    const breaks = await tx.breaks.list({
      where: { tenantId: this.actor.tenantId, punchId: punch.id },
    });
    const active = breaks.find((b) => !b.endedAt);
    if (action === 'startBreak') {
      if (active)
        throw new AttendanceConflict('A break is already open.', 'break_open');
      if (typeof paid !== 'boolean')
        throw new AttendanceConflict('paid must be boolean.');
      await closeOpenSegment(tx, punch, at, 'break');
      await tx.breaks.create({
        tenantId: this.actor.tenantId,
        punchId: punch.id ?? undefined,
        startedAt: at,
        paid,
        kind: meta.kind,
        _insertOnly: true,
      });
      return punch;
    }
    if (action !== 'endBreak' && action !== 'punchOut')
      throw new AttendanceConflict('Unknown attendance action.');
    if (action === 'endBreak' && !active)
      throw new AttendanceConflict('No open break.', 'no_open_break');
    if (action === 'punchOut' && work) {
      this.validateWork(work);
      const unpaidMilliseconds = breaks
        .filter((b) => !b.paid)
        .reduce(
          (sum, b) => sum + (b.endedAt ?? at).getTime() - b.startedAt.getTime(),
          0,
        );
      if (
        Math.round(
          (at.getTime() - punch.startedAt.getTime() - unpaidMilliseconds) /
            1000,
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
    if (action === 'endBreak') {
      if (resumeWork) await continueSegment(tx, punch, at);
      return punch;
    }
    await closeOpenSegment(tx, punch, at, 'punchOut');
    punch.endedAt = at;
    const unpaidMilliseconds = breaks
      .filter((b) => !b.paid)
      .reduce(
        (sum, b) => sum + b.endedAt!.getTime() - b.startedAt.getTime(),
        0,
      );
    punch.unpaidBreakSeconds = Math.round(unpaidMilliseconds / 1000);
    punch.durationSeconds = Math.round(
      (at.getTime() - punch.startedAt.getTime() - unpaidMilliseconds) / 1000,
    );
    await punch.save();
    if (work) await this.link(tx, punch, work);
    return punch;
  }

  /** Run one replayed tap on `tx`; work actions share the punch changes' transaction. */
  private async apply(
    tx: Context,
    tap: AttendanceTap,
    at: Date,
  ): Promise<{ punch: AttendancePunch; segment?: AttendanceSegment }> {
    const work = (): AttendanceWork => {
      if (!tap.work)
        throw new AttendanceConflict('Work is required.', 'invalid');
      return tap.work;
    };
    let segment: AttendanceSegment;
    switch (tap.action) {
      case 'startWork':
        await this.chronological(tx, at);
        segment = await beginSegment(tx, await this.open(tx), at, work());
        break;
      case 'switchWork':
        await this.chronological(tx, at);
        segment = await replaceSegment(tx, await this.open(tx), at, work());
        break;
      case 'stopWork':
        await this.chronological(tx, at);
        segment = await endSegment(tx, await this.open(tx), at);
        break;
      case 'resumeWork':
        await this.chronological(tx, at);
        segment = await continueSegment(tx, await this.open(tx), at);
        break;
      default:
        return {
          punch: await this.transition(
            tx,
            tap.action,
            at,
            tap.paid,
            tap.work,
            false,
            {
              ...attendanceProvenance({
                source: tap.source,
                device: tap.device,
              }),
              kind: attendanceLabel(tap.kind, 'kind'),
            },
          ),
        };
    }
    const [punch] = await tx.punches.list({
      where: { ...this.actor, id: segment.punchId },
      limit: 1,
    });
    return { punch, segment };
  }

  private validateWork(work: AttendanceWork): void {
    validateAttendanceWork(work);
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
        existing.description !== work.description ||
        !sameAttribution(existing.metadata, work)
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
      metadata: JSON.stringify({
        attendancePunchId: punch.id,
        ...(work.taskRefType
          ? { taskRefType: work.taskRefType, taskRefId: work.taskRefId }
          : {}),
        ...(work.kind ? { kind: work.kind } : {}),
      }),
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

  /**
   * Close the open punch once its deadline has passed, flagging it for review.
   * `deadline` is either a fixed maximum open duration in seconds (closing at
   * `startedAt + seconds`, reason `maxDuration`) or a resolver called with the
   * open punch that returns its deadline (a `Date`, or `{ deadline, reason }`),
   * or null to leave it open. The consumer owns time zones and shop-day rules.
   * The open work segment and break close at the deadline; returns the closed
   * punch, or null when nothing was due.
   */
  async autoClose(
    now: Date,
    deadline: AttendanceAutoCloseDeadline,
  ): Promise<AttendancePunch | null> {
    this.date(now);
    if (
      typeof deadline !== 'function' &&
      (!Number.isSafeInteger(deadline) || deadline <= 0)
    )
      throw new AttendanceConflict(
        'maxOpenSeconds must be a positive integer.',
      );
    return this.transact(async (tx) => {
      const [punch] = await tx.punches.list({
        where: { ...this.actor, endedAt: null },
        limit: 1,
      });
      if (!punch) return null;
      let at: Date;
      let reason = 'maxDuration';
      if (typeof deadline === 'function') {
        const resolved = await deadline(punch);
        if (resolved === null || resolved === undefined) return null;
        const decision =
          resolved instanceof Date ? { deadline: resolved } : resolved;
        at = decision.deadline;
        if (!(at instanceof Date) || !Number.isFinite(at.getTime()))
          throw new AttendanceConflict('Auto-close deadline is invalid.');
        if (at < punch.startedAt)
          throw new AttendanceConflict(
            'Auto-close deadline predates the punch.',
          );
        reason = decision.reason ?? 'deadline';
        if (typeof reason !== 'string' || !reason.trim() || reason.length > 200)
          throw new AttendanceConflict(
            'Auto-close reason must be 1 to 200 characters.',
          );
      } else {
        at = new Date(punch.startedAt.getTime() + deadline * 1000);
      }
      if (at > now) return null;
      // Do not truncate a later committed break. The conflict requires manual review.
      const closed = await this.transition(tx, 'punchOut', at);
      closed.reviewRequired = true;
      closed.autoCloseReason = reason;
      await persistAutoClose(closed);
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
    options: AttendanceReplayOptions = {},
  ): Promise<AttendanceReplayOutcome[]> {
    for (const tap of taps) {
      if (
        !tap ||
        typeof tap.at !== 'string' ||
        typeof tap.clientId !== 'string' ||
        !tap.clientId ||
        !TAP_ACTIONS.includes(tap.action)
      )
        throw new AttendanceConflict('Malformed attendance tap.');
      this.date(new Date(tap.at));
      if (tap.work !== undefined) this.validateWork(tap.work);
      if (
        (tap.action === 'startWork' || tap.action === 'switchWork') &&
        tap.work === undefined
      )
        throw new AttendanceConflict('Malformed attendance tap.');
      if (tap.paid !== undefined && typeof tap.paid !== 'boolean')
        throw new AttendanceConflict('paid must be boolean.');
      attendanceProvenance({ source: tap.source, device: tap.device });
      attendanceLabel(tap.kind, 'kind');
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
            ...(tap.work?.taskRefType || tap.work?.kind
              ? [
                  tap.work.taskRefType ?? null,
                  tap.work.taskRefId ?? null,
                  tap.work.kind ?? null,
                ]
              : []),
            // Provenance joins the hash only when present, so receipts of taps
            // that carry none are unchanged.
            ...(tap.source || tap.device || tap.kind
              ? [
                  {
                    source: tap.source ?? '',
                    deviceType: tap.device?.type ?? '',
                    deviceId: tap.device?.id ?? '',
                    kind: tap.kind ?? '',
                  },
                ]
              : []),
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
          const deviceAt = new Date(tap.at);
          let at = deviceAt;
          let review = false;
          let punchReview = true;
          let offline = true;
          if (options.resolveAt) {
            const serverNow = this.date(options.now?.() ?? new Date());
            const resolved = await options.resolveAt({
              tap,
              deviceAt,
              serverNow,
              waitedMs: serverNow.getTime() - deviceAt.getTime(),
              actor: { ...this.actor },
            });
            if (
              !resolved ||
              !(resolved.at instanceof Date) ||
              !Number.isFinite(resolved.at.getTime())
            )
              throw new Error('resolveAt must return a valid date.');
            at = resolved.at;
            review = resolved.reviewRequired === true;
            punchReview = resolved.reviewRequired !== false;
            offline = resolved.recordedOffline !== false;
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
                  segments: await AttendanceSegmentCollection.create({ db }),
                  replays: tx.replays,
                };
                const { punch, segment } = await this.apply(inner, tap, at);
                punch.recordedOffline = offline;
                punch.reviewRequired = punchReview;
                await punch.save();
                if (segment && review) {
                  segment.reviewRequired = true;
                  await segment.save();
                }
                return {
                  clientId: tap.clientId,
                  punchId: punch.id!,
                  ...(segment ? { segmentId: segment.id! } : {}),
                  ...(at.getTime() !== deviceAt.getTime()
                    ? { resolvedAt: at.toISOString() }
                    : {}),
                };
              },
              true,
            );
          } catch (error) {
            if (!(error instanceof AttendanceConflict)) throw error;
            const custom = options.refusal?.(tap, error) || undefined;
            outcome = {
              clientId: tap.clientId,
              error: custom?.message || error.message,
              code: custom?.code || error.code,
            };
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
