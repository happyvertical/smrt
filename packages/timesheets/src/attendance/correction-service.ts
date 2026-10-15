import type { DatabaseInterface } from '@happyvertical/sql';
import { ServiceTimeEntryCollection } from '../models/service-time-entry.js';
import {
  type AttendanceActor,
  AttendanceConflict,
  type AttendanceContext,
  type AttendancePunchOptions,
  type AttendanceWork,
  attendanceIdentity,
  attendanceLabel,
  attendanceProvenance,
  validateAttendanceWork,
} from './context.js';
import {
  AttendanceCorrection,
  AttendanceCorrectionCollection,
  type AttendanceCorrectionKind,
} from './correction-models.js';
import {
  AttendanceBreak,
  type AttendancePunch,
  AttendanceSegment,
} from './models.js';
import { AttendanceService } from './service.js';
import { deleteCorrection, persistCorrection } from './write.js';

/** A closed time range a correction touches, for period-lock checks. */
export interface AttendanceCorrectionInterval {
  startsAt: Date;
  endsAt: Date;
}

/**
 * Optional period lock, run on the correction's transaction before any write.
 * Return a message to refuse the correction (for example "overlaps a confirmed
 * timecard"), or null to allow it. `confirmedTimecardGuard` in `./rollup` is the
 * ready-made one.
 */
export type AttendanceCorrectionGuard = (
  tx: AttendanceContext,
  subject: AttendanceActor,
  intervals: readonly AttendanceCorrectionInterval[],
) => Promise<string | null>;

export interface AttendanceCorrectionOptions {
  guard?: AttendanceCorrectionGuard;
}

/** Fields every correction carries. */
export interface AttendanceCorrectionRequest {
  /** Whose time is being corrected. */
  subjectProfileId: string;
  /** Required, non-blank. Stored verbatim (trimmed) on the ledger row. */
  reason: string;
  /** When true the subject must `acknowledge()` the correction. */
  acknowledgementRequired?: boolean;
}

export interface CorrectPunchInput extends AttendanceCorrectionRequest {
  punchId: string;
  startedAt?: Date;
  endedAt?: Date;
}
export interface AddPunchInput
  extends AttendanceCorrectionRequest,
    AttendancePunchOptions {
  startedAt: Date;
  endedAt: Date;
}
/** Adds a break when `breakId` is absent; otherwise changes that break. */
export interface SaveBreakInput extends AttendanceCorrectionRequest {
  punchId: string;
  breakId?: string;
  startedAt?: Date;
  endedAt?: Date;
  paid?: boolean;
  /** Short consumer-owned label (for example `meal`); omit to keep, `''` to clear. */
  kind?: string;
}
export interface RemoveBreakInput extends AttendanceCorrectionRequest {
  breakId: string;
}
/**
 * Adds a segment when `segmentId` is absent (`startedAt`, `endedAt` and `work`
 * are then required); otherwise changes that segment, keeping what is omitted.
 */
export interface SaveSegmentInput extends AttendanceCorrectionRequest {
  punchId: string;
  segmentId?: string;
  startedAt?: Date;
  endedAt?: Date;
  work?: AttendanceWork;
}
export interface RemoveSegmentInput extends AttendanceCorrectionRequest {
  segmentId: string;
}

interface Layout {
  startsAt: number;
  endsAt: number;
  breaks: { startedAt: Date; endedAt: Date; paid: boolean }[];
  segments: { startedAt: Date; endedAt: Date }[];
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const punchState = (p: AttendancePunch) => ({
  startedAt: iso(p.startedAt),
  endedAt: iso(p.endedAt),
  durationSeconds: p.durationSeconds,
  unpaidBreakSeconds: p.unpaidBreakSeconds,
  reviewRequired: p.reviewRequired,
  ...(p.source ? { source: p.source } : {}),
  ...(p.deviceRefType
    ? { deviceRefType: p.deviceRefType, deviceRefId: p.deviceRefId }
    : {}),
});
const breakState = (b: AttendanceBreak) => ({
  startedAt: iso(b.startedAt),
  endedAt: iso(b.endedAt),
  paid: b.paid,
  ...(b.kind ? { kind: b.kind } : {}),
});
const segmentState = (s: AttendanceSegment) => ({
  startedAt: iso(s.startedAt),
  endedAt: iso(s.endedAt),
  workRefType: s.workRefType,
  workRefId: s.workRefId,
  taskRefType: s.taskRefType,
  taskRefId: s.taskRefId,
  kind: s.kind,
  description: s.description,
  durationSeconds: s.durationSeconds,
  closedReason: s.closedReason,
});

function instant(value: Date | undefined, name: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw new AttendanceConflict(`${name} must be a valid date.`);
  return value;
}

function overlapping(
  a: { start: number; end: number },
  b: { start: number; end: number },
): boolean {
  return a.start < b.end && b.start < a.end;
}

function validateLayout(layout: Layout): void {
  const inside = (r: { startedAt: Date; endedAt: Date }) =>
    r.endedAt.getTime() >= r.startedAt.getTime() &&
    r.startedAt.getTime() >= layout.startsAt &&
    r.endedAt.getTime() <= layout.endsAt;
  if (!layout.breaks.every(inside))
    throw new AttendanceConflict(
      'A break must be an interval inside its punch.',
    );
  if (!layout.segments.every(inside))
    throw new AttendanceConflict(
      'A work segment must be an interval inside its punch.',
    );
  const span = (r: { startedAt: Date; endedAt: Date }) => ({
    start: r.startedAt.getTime(),
    end: r.endedAt.getTime(),
  });
  const sets = [layout.breaks, layout.segments];
  for (const set of sets)
    for (let i = 0; i < set.length; i++)
      for (let j = i + 1; j < set.length; j++)
        if (overlapping(span(set[i]), span(set[j])))
          throw new AttendanceConflict(
            set === layout.breaks
              ? 'Breaks must not overlap.'
              : 'Work segments must not overlap.',
          );
  for (const b of layout.breaks)
    for (const s of layout.segments)
      if (overlapping(span(b), span(s)))
        throw new AttendanceConflict(
          'A work segment must not overlap a break.',
        );
}

/**
 * Corrections to closed attendance, with a paper trail.
 *
 * `actor` is who makes the change; each request names the `subjectProfileId`
 * whose time it is. The application authorizes the actor (and decides whether
 * they may correct this subject) before constructing the service, exactly as
 * for `AttendanceService`. This service is the only path that may change a
 * closed punch, break or segment: each method validates the resulting layout
 * (everything inside its punch, no overlapping breaks, segments or punches,
 * no segment across a break), recomputes `durationSeconds` and
 * `unpaidBreakSeconds`, keeps a still-draft linked service entry in step, and
 * appends an `AttendanceCorrection` row, all in one transaction serialized with
 * the subject's own taps. Open punches are not corrected here: use
 * `AttendanceService`.
 */
export class AttendanceCorrectionService {
  private readonly actor: AttendanceActor;
  constructor(
    private readonly db: DatabaseInterface,
    actor: AttendanceActor,
    private readonly options: AttendanceCorrectionOptions = {},
  ) {
    if (!actor?.tenantId || !actor.profileId)
      throw new Error('Corrections require a trusted tenant/profile actor.');
    this.actor = {
      tenantId: attendanceIdentity(db, actor.tenantId),
      profileId: attendanceIdentity(db, actor.profileId),
    };
  }

  /** Change a closed punch's start and/or end. A reviewed punch no longer needs review. */
  async correctPunch(input: CorrectPunchInput): Promise<AttendanceCorrection> {
    return this.run(input, async (tx, subject, record) => {
      const punch = await this.closedPunch(tx, subject, input.punchId);
      const before = punchState(punch);
      const startedAt =
        input.startedAt === undefined
          ? punch.startedAt
          : instant(input.startedAt, 'startedAt');
      const endedAt =
        input.endedAt === undefined
          ? punch.endedAt!
          : instant(input.endedAt, 'endedAt');
      if (endedAt <= startedAt)
        throw new AttendanceConflict('A punch must end after it starts.');
      const children = await this.children(tx, punch);
      validateLayout(this.layout(startedAt, endedAt, children));
      for (const other of await tx.punches.list({
        where: { tenantId: subject.tenantId, profileId: subject.profileId },
      }))
        if (
          other.id !== punch.id &&
          overlapping(
            { start: startedAt.getTime(), end: endedAt.getTime() },
            {
              start: other.startedAt.getTime(),
              end: other.endedAt?.getTime() ?? Number.POSITIVE_INFINITY,
            },
          )
        )
          throw new AttendanceConflict('Punches must not overlap.');
      await this.guard(tx, subject, [
        { startsAt: punch.startedAt, endsAt: punch.endedAt! },
        { startsAt: startedAt, endsAt: endedAt },
      ]);
      const entry = await this.editableEntry(tx, punch);
      punch.startedAt = startedAt;
      punch.endedAt = endedAt;
      punch.reviewRequired = false;
      await this.settle(tx, punch, children.breaks, entry);
      return record(
        'punch.corrected',
        punch,
        punch.id!,
        before,
        punchState(punch),
      );
    });
  }

  /** Record a missed punch retroactively, as an already-closed interval. */
  async addPunch(input: AddPunchInput): Promise<AttendanceCorrection> {
    return this.run(input, async (tx, subject, record) => {
      const startedAt = instant(input.startedAt, 'startedAt');
      const endedAt = instant(input.endedAt, 'endedAt');
      const meta = attendanceProvenance(input);
      if (endedAt <= startedAt)
        throw new AttendanceConflict('A punch must end after it starts.');
      for (const other of await tx.punches.list({
        where: { tenantId: subject.tenantId, profileId: subject.profileId },
      }))
        if (
          overlapping(
            { start: startedAt.getTime(), end: endedAt.getTime() },
            {
              start: other.startedAt.getTime(),
              end: other.endedAt?.getTime() ?? Number.POSITIVE_INFINITY,
            },
          )
        )
          throw new AttendanceConflict('Punches must not overlap.');
      await this.guard(tx, subject, [{ startsAt: startedAt, endsAt: endedAt }]);
      const punch = await tx.punches.create({
        tenantId: subject.tenantId,
        profileId: subject.profileId,
        startedAt,
        endedAt,
        durationSeconds: Math.round(
          (endedAt.getTime() - startedAt.getTime()) / 1000,
        ),
        ...meta,
        _insertOnly: true,
      });
      return record('punch.added', punch, punch.id!, null, punchState(punch));
    });
  }

  /** Add a break to a closed punch, or change one (times and/or paid). */
  async saveBreak(input: SaveBreakInput): Promise<AttendanceCorrection> {
    return this.run(input, async (tx, subject, record) => {
      const punch = await this.closedPunch(tx, subject, input.punchId);
      const children = await this.children(tx, punch);
      const existing = input.breakId
        ? children.breaks.find((b) => b.id === input.breakId)
        : undefined;
      if (input.breakId && !existing)
        throw new AttendanceConflict('Break not found in that punch.');
      if (
        !existing &&
        (input.startedAt === undefined || input.endedAt === undefined)
      )
        throw new AttendanceConflict(
          'A new break needs startedAt and endedAt.',
        );
      if (input.paid !== undefined && typeof input.paid !== 'boolean')
        throw new AttendanceConflict('paid must be boolean.');
      const next = {
        startedAt: instant(input.startedAt ?? existing?.startedAt, 'startedAt'),
        endedAt: instant(
          input.endedAt ?? existing?.endedAt ?? undefined,
          'endedAt',
        ),
        paid: input.paid ?? existing?.paid ?? false,
        kind:
          input.kind === undefined
            ? (existing?.kind ?? '')
            : attendanceLabel(input.kind, 'kind'),
      };
      const rest = children.breaks.filter((b) => b !== existing);
      validateLayout(
        this.layout(punch.startedAt, punch.endedAt!, {
          breaks: [...rest, next as unknown as AttendanceBreak],
          segments: children.segments,
        }),
      );
      await this.guard(tx, subject, [
        { startsAt: punch.startedAt, endsAt: punch.endedAt! },
      ]);
      const entry = await this.editableEntry(tx, punch);
      const before = existing ? breakState(existing) : null;
      let target: AttendanceBreak;
      if (existing) {
        existing.startedAt = next.startedAt;
        existing.endedAt = next.endedAt;
        existing.paid = next.paid;
        existing.kind = next.kind;
        await persistCorrection(existing);
        target = existing;
      } else {
        target = await new AttendanceBreak({
          db: tx.db,
          id: crypto.randomUUID(),
          _skipLoad: true,
        }).initialize();
        Object.assign(target, {
          tenantId: subject.tenantId,
          punchId: punch.id ?? undefined,
          ...next,
        });
        await persistCorrection(target);
      }
      await this.settle(tx, punch, [...rest, target], entry);
      return record(
        existing ? 'break.changed' : 'break.added',
        punch,
        target.id!,
        before,
        breakState(target),
      );
    });
  }

  /** Remove a break from a closed punch. */
  async removeBreak(input: RemoveBreakInput): Promise<AttendanceCorrection> {
    return this.run(input, async (tx, subject, record) => {
      const [target] = await tx.breaks.list({
        where: { tenantId: subject.tenantId, id: input.breakId },
        limit: 1,
      });
      if (!target) throw new AttendanceConflict('Break not found.');
      const punch = await this.closedPunch(tx, subject, target.punchId);
      const children = await this.children(tx, punch);
      await this.guard(tx, subject, [
        { startsAt: punch.startedAt, endsAt: punch.endedAt! },
      ]);
      const entry = await this.editableEntry(tx, punch);
      const before = breakState(target);
      await deleteCorrection(target);
      await this.settle(
        tx,
        punch,
        children.breaks.filter((b) => b.id !== target.id),
        entry,
      );
      return record('break.removed', punch, target.id!, before, null);
    });
  }

  /** Add a work segment to a closed punch, or change one (times and/or work attribution). */
  async saveSegment(input: SaveSegmentInput): Promise<AttendanceCorrection> {
    return this.run(input, async (tx, subject, record) => {
      const punch = await this.closedPunch(tx, subject, input.punchId);
      const children = await this.children(tx, punch);
      const existing = input.segmentId
        ? children.segments.find((s) => s.id === input.segmentId)
        : undefined;
      if (input.segmentId && !existing)
        throw new AttendanceConflict('Work segment not found in that punch.');
      if (
        !existing &&
        (input.startedAt === undefined ||
          input.endedAt === undefined ||
          !input.work)
      )
        throw new AttendanceConflict(
          'A new work segment needs startedAt, endedAt and work.',
        );
      if (input.work) validateAttendanceWork(input.work);
      const next = {
        startedAt: instant(input.startedAt ?? existing?.startedAt, 'startedAt'),
        endedAt: instant(
          input.endedAt ?? existing?.endedAt ?? undefined,
          'endedAt',
        ),
      };
      const rest = children.segments.filter((s) => s !== existing);
      validateLayout(
        this.layout(punch.startedAt, punch.endedAt!, {
          breaks: children.breaks,
          segments: [...rest, next as unknown as AttendanceSegment],
        }),
      );
      await this.guard(tx, subject, [
        { startsAt: punch.startedAt, endsAt: punch.endedAt! },
      ]);
      const before = existing ? segmentState(existing) : null;
      let target: AttendanceSegment;
      if (existing) {
        existing.startedAt = next.startedAt;
        existing.endedAt = next.endedAt;
        if (input.work) this.attribute(existing, input.work);
        await persistCorrection(existing);
        target = existing;
      } else {
        target = await new AttendanceSegment({
          db: tx.db,
          id: crypto.randomUUID(),
          _skipLoad: true,
        }).initialize();
        Object.assign(target, {
          tenantId: subject.tenantId,
          punchId: punch.id ?? undefined,
          workRefType: input.work!.workRefType,
          workRefId: input.work!.workRefId,
          taskRefType: input.work!.taskRefType ?? '',
          taskRefId: input.work!.taskRefId ?? '',
          kind: input.work!.kind ?? '',
          description: input.work!.description,
          ...next,
          closedReason: 'stop',
        });
        await persistCorrection(target);
      }
      return record(
        existing ? 'segment.changed' : 'segment.added',
        punch,
        target.id!,
        before,
        segmentState(target),
      );
    });
  }

  /** Remove a work segment from a closed punch. */
  async removeSegment(
    input: RemoveSegmentInput,
  ): Promise<AttendanceCorrection> {
    return this.run(input, async (tx, subject, record) => {
      const [target] = await tx.segments.list({
        where: { tenantId: subject.tenantId, id: input.segmentId },
        limit: 1,
      });
      if (!target) throw new AttendanceConflict('Work segment not found.');
      const punch = await this.closedPunch(tx, subject, target.punchId);
      await this.guard(tx, subject, [
        { startsAt: punch.startedAt, endsAt: punch.endedAt! },
      ]);
      const before = segmentState(target);
      await deleteCorrection(target);
      return record('segment.removed', punch, target.id!, before, null);
    });
  }

  /**
   * The subject confirms they have seen a correction that required it. Only
   * the subject (this service's actor) may; it can be done once.
   */
  async acknowledge(
    correctionId: string,
    at: Date = new Date(),
  ): Promise<AttendanceCorrection> {
    instant(at, 'at');
    const id = await this.attendance(this.actor.profileId).withTransaction(
      async (tx) => {
        const ledger = await AttendanceCorrectionCollection.create({
          db: tx.db,
        });
        const [row] = await ledger.list({
          where: { tenantId: this.actor.tenantId, id: correctionId },
          limit: 1,
        });
        if (!row) throw new AttendanceConflict('Correction not found.');
        if (row.subjectProfileId !== this.actor.profileId)
          throw new AttendanceConflict(
            'Only the subject can acknowledge a correction.',
          );
        if (!row.acknowledgementRequired)
          throw new AttendanceConflict(
            'This correction does not require acknowledgement.',
          );
        if (row.acknowledgedAt)
          throw new AttendanceConflict('Correction already acknowledged.');
        row.acknowledgedAt = at;
        row.acknowledgedByProfileId = this.actor.profileId;
        await persistCorrection(row);
        return row.id!;
      },
    );
    return this.read(id);
  }

  /** Corrections to one punch, oldest first. */
  async listForPunch(punchId: string): Promise<AttendanceCorrection[]> {
    return this.attendance(this.actor.profileId).withTransaction(
      async (tx) =>
        await (await AttendanceCorrectionCollection.create({ db: tx.db })).list(
          {
            where: { tenantId: this.actor.tenantId, punchId },
            orderBy: 'created_at ASC',
          },
        ),
    );
  }

  /** Corrections of the actor's own time that still await their acknowledgement. */
  async pendingAcknowledgements(): Promise<AttendanceCorrection[]> {
    return this.attendance(this.actor.profileId).withTransaction(async (tx) =>
      (
        await (
          await AttendanceCorrectionCollection.create({ db: tx.db })
        ).list({
          where: {
            tenantId: this.actor.tenantId,
            subjectProfileId: this.actor.profileId,
          },
          orderBy: 'created_at ASC',
        })
      ).filter((row) => row.acknowledgementRequired && !row.acknowledgedAt),
    );
  }

  private attendance(subjectProfileId: string): AttendanceService {
    return new AttendanceService(this.db, {
      tenantId: this.actor.tenantId,
      profileId: subjectProfileId,
    });
  }

  private async read(id: string): Promise<AttendanceCorrection> {
    return this.attendance(this.actor.profileId).withTransaction(async (tx) => {
      const [row] = await (
        await AttendanceCorrectionCollection.create({ db: tx.db })
      ).list({ where: { tenantId: this.actor.tenantId, id }, limit: 1 });
      if (!row) throw new Error('Committed attendance correction disappeared.');
      return row;
    });
  }

  private async run(
    request: AttendanceCorrectionRequest,
    operation: (
      tx: AttendanceContext,
      subject: AttendanceActor,
      record: (
        kind: AttendanceCorrectionKind,
        punch: AttendancePunch,
        targetId: string,
        before: object | null,
        after: object | null,
      ) => Promise<string>,
    ) => Promise<string>,
  ): Promise<AttendanceCorrection> {
    const reason =
      typeof request.reason === 'string' ? request.reason.trim() : '';
    if (!reason) throw new AttendanceConflict('A correction needs a reason.');
    if (
      request.acknowledgementRequired !== undefined &&
      typeof request.acknowledgementRequired !== 'boolean'
    )
      throw new AttendanceConflict('acknowledgementRequired must be boolean.');
    if (!request.subjectProfileId)
      throw new AttendanceConflict('A correction needs a subject.');
    const subject: AttendanceActor = {
      tenantId: this.actor.tenantId,
      profileId: attendanceIdentity(this.db, request.subjectProfileId),
    };
    const id = await this.attendance(subject.profileId).withTransaction(
      async (tx) => {
        // Initialise the ledger table binding on this executor before writing.
        await AttendanceCorrectionCollection.create({ db: tx.db });
        return operation(
          tx,
          subject,
          async (kind, punch, targetId, before, after) => {
            const row = await new AttendanceCorrection({
              db: tx.db,
              id: crypto.randomUUID(),
              _skipLoad: true,
            }).initialize();
            Object.assign(row, {
              tenantId: subject.tenantId,
              subjectProfileId: subject.profileId,
              actorProfileId: this.actor.profileId,
              kind,
              punchId: punch.id ?? undefined,
              targetId,
              beforeState: JSON.stringify(before),
              afterState: JSON.stringify(after),
              reason,
              acknowledgementRequired: request.acknowledgementRequired ?? false,
            });
            await persistCorrection(row);
            return row.id!;
          },
        );
      },
    );
    return this.read(id);
  }

  private async closedPunch(
    tx: AttendanceContext,
    subject: AttendanceActor,
    punchId: string,
  ): Promise<AttendancePunch> {
    const [punch] = await tx.punches.list({
      where: {
        tenantId: subject.tenantId,
        profileId: subject.profileId,
        id: punchId,
      },
      limit: 1,
    });
    if (!punch) throw new AttendanceConflict('Punch not found for subject.');
    if (!punch.endedAt)
      throw new AttendanceConflict(
        'Only closed punches are corrected; use AttendanceService for an open one.',
      );
    return punch;
  }

  private async children(tx: AttendanceContext, punch: AttendancePunch) {
    const where = { tenantId: punch.tenantId, punchId: punch.id };
    const breaks = await tx.breaks.list({ where, orderBy: 'started_at ASC' });
    const segments = await tx.segments.list({
      where,
      orderBy: 'started_at ASC',
    });
    if (breaks.some((b) => !b.endedAt) || segments.some((s) => !s.endedAt))
      throw new AttendanceConflict(
        'Closed punch has an open break or segment.',
      );
    return { breaks, segments };
  }

  private layout(
    startedAt: Date,
    endedAt: Date,
    children: {
      breaks: readonly AttendanceBreak[];
      segments: readonly AttendanceSegment[];
    },
  ): Layout {
    return {
      startsAt: startedAt.getTime(),
      endsAt: endedAt.getTime(),
      breaks: children.breaks.map((b) => ({
        startedAt: b.startedAt,
        endedAt: b.endedAt!,
        paid: b.paid,
      })),
      segments: children.segments.map((s) => ({
        startedAt: s.startedAt,
        endedAt: s.endedAt!,
      })),
    };
  }

  private attribute(segment: AttendanceSegment, work: AttendanceWork): void {
    segment.workRefType = work.workRefType;
    segment.workRefId = work.workRefId;
    segment.taskRefType = work.taskRefType ?? '';
    segment.taskRefId = work.taskRefId ?? '';
    segment.kind = work.kind ?? '';
    segment.description = work.description;
  }

  private async guard(
    tx: AttendanceContext,
    subject: AttendanceActor,
    intervals: readonly AttendanceCorrectionInterval[],
  ): Promise<void> {
    const refusal = await this.options.guard?.(tx, subject, intervals);
    if (refusal) throw new AttendanceConflict(refusal);
  }

  /** The punch's still-draft evidence entry, refusing when it is no longer editable. */
  private async editableEntry(tx: AttendanceContext, punch: AttendancePunch) {
    if (!punch.serviceTimeEntryId) return null;
    const entries = await ServiceTimeEntryCollection.create({ db: tx.db });
    const [entry] = await entries.list({
      where: { id: punch.serviceTimeEntryId, tenantId: punch.tenantId },
      limit: 1,
    });
    if (!entry) return null;
    if (entry.status !== 'draft')
      throw new AttendanceConflict(
        `Linked service evidence is ${entry.status}; correct it with ServiceEvidenceService first.`,
      );
    return entry;
  }

  /** Recompute the punch's durations from its breaks and persist it and its draft entry. */
  private async settle(
    tx: AttendanceContext,
    punch: AttendancePunch,
    breaks: readonly AttendanceBreak[],
    entry: Awaited<ReturnType<AttendanceCorrectionService['editableEntry']>>,
  ): Promise<void> {
    const unpaidMs = breaks
      .filter((b) => !b.paid)
      .reduce(
        (sum, b) => sum + b.endedAt!.getTime() - b.startedAt.getTime(),
        0,
      );
    punch.unpaidBreakSeconds = Math.round(unpaidMs / 1000);
    punch.durationSeconds = Math.round(
      (punch.endedAt!.getTime() - punch.startedAt.getTime() - unpaidMs) / 1000,
    );
    await persistCorrection(punch);
    if (entry) {
      entry.startedAt = punch.startedAt;
      entry.endedAt = punch.endedAt;
      entry.durationSeconds = punch.durationSeconds;
      await entry.save();
    }
  }
}
