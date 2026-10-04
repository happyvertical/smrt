import type { DatabaseInterface } from '@happyvertical/sql';
import { addDays, assertIsoDate, dateWithin } from '../dates.js';
import { revokeEmploymentQualifications } from '../qualifications/internal.js';
import { HrService } from '../service-base.js';
import {
  EMPLOYMENT_STATUS_TRANSITIONS,
  type EmploymentChangeKind,
  type EmploymentCheck,
  type EmploymentStatus,
  HrError,
  type IsoDate,
  type WorkerType,
} from '../types.js';
import { insertHr, persistHr } from '../write.js';
import {
  Employment,
  EmploymentChange,
  EmploymentChangeCollection,
  EmploymentCollection,
  EmploymentTerm,
  EmploymentTermCollection,
} from './models.js';
import { employmentsOn } from './queries.js';

/** Input to {@link EmploymentService.hire}. */
export interface HireInput {
  /** The person being employed (`smrt-profiles:Profile` id). */
  profileId: string;
  /** Free text, unique per tenant; surrounding whitespace is trimmed. */
  employeeNumber: string;
  /** First day employed. */
  startedOn: IsoDate;
  /** Lowercase kebab-case; defaults to `employee`. */
  workerType?: WorkerType;
  /** Position or trade label; blank means none. */
  position?: string | null;
  /** Optional login (`smrt-users:User` id). */
  userId?: string | null;
  /** Optional organization profile when it differs from the tenant itself. */
  employerProfileId?: string | null;
}

/** Input to {@link EmploymentService.end}. */
export interface EndEmploymentInput {
  /** The last day employed, inclusive. */
  endedOn: IsoDate;
  /** Free-text reason kept on the closed term and the change row. */
  reason?: string;
}

/** Input to {@link EmploymentService.rehire}. */
export interface RehireInput {
  /** First day of the new term; must be after the previous term's last day. */
  startedOn: IsoDate;
  /** New worker type; omitted keeps the previous one. */
  workerType?: WorkerType;
  /** New position (null clears it); omitted keeps the previous one. */
  position?: string | null;
}

/** Input to {@link EmploymentService.changePosition}. */
export interface ChangePositionInput {
  /** The new position; null or blank clears it. */
  position: string | null;
  /** The day the new position takes effect. */
  effectiveOn: IsoDate;
  /** Optional note kept on the change row. */
  note?: string;
}

/** Input to {@link EmploymentService.changeWorkerType}. */
export interface ChangeWorkerTypeInput {
  /** The new worker type, lowercase kebab-case. */
  workerType: WorkerType;
  /** The day the new worker type takes effect. */
  effectiveOn: IsoDate;
  /** Optional note kept on the change row. */
  note?: string;
}

/** Input to {@link EmploymentService.placeOnLeave} and {@link EmploymentService.returnFromLeave}. */
export interface LeaveInput {
  /** The first day of leave, or the first day back. */
  effectiveOn: IsoDate;
  /** Optional note kept on the change row. */
  note?: string;
}

/** Input to {@link EmploymentService.linkLogin} and {@link EmploymentService.unlinkLogin}. */
export interface LoginLinkInput {
  /**
   * The date recorded on the change row. It does not schedule anything: the
   * link or unlink takes effect as soon as it is recorded.
   */
  effectiveOn: IsoDate;
}

/** An employment's recorded state on one calendar date. */
export interface EmploymentAsOf {
  /** Position in effect on the date; before any change, the position at hire. */
  position: string | null;
  /** Worker type in effect on the date; before any change, the type at hire. */
  workerType: string;
  /** Whether a term covers the date. */
  employed: boolean;
  /** Whether the person was employed and on leave on the date. */
  onLeave: boolean;
}

const WORKER_TYPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Changes that belong to a term and are replayed by `check` and `asOf`. Login
 * links are not: they are not replayed and may be recorded at any time.
 */
const TERM_CHANGE_KINDS: readonly EmploymentChangeKind[] = [
  'hired',
  'ended',
  'rehired',
  'position-changed',
  'worker-type-changed',
  'leave-started',
  'leave-ended',
];

const LEAVE_CHANGE_KINDS: readonly EmploymentChangeKind[] = [
  'leave-started',
  'leave-ended',
];

function workerTypeOf(value: unknown): WorkerType {
  if (typeof value !== 'string' || !WORKER_TYPE.test(value))
    throw new HrError(
      'HR_INVALID',
      `workerType must be lowercase kebab-case, got '${String(value)}'.`,
    );
  return value;
}

function positionOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string')
    throw new HrError('HR_INVALID', 'position must be text or null.');
  return value.trim() || null;
}

function noteOf(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string')
    throw new HrError('HR_INVALID', 'A note or reason must be text.');
  return value.trim();
}

function createdTime(change: EmploymentChange): number {
  const at = change.created_at;
  const time = at ? new Date(at).getTime() : 0;
  return Number.isNaN(time) ? 0 : time;
}

function inHistoryOrder(changes: EmploymentChange[]): EmploymentChange[] {
  return [...changes].sort((a, b) =>
    a.effectiveOn === b.effectiveOn
      ? createdTime(a) - createdTime(b)
      : a.effectiveOn < b.effectiveOn
        ? -1
        : 1,
  );
}

/** Whether the replayed history leaves the person on leave on `on`. */
function onLeaveOn(history: EmploymentChange[], on: IsoDate): boolean {
  let onLeave = false;
  for (const change of history) {
    if (change.effectiveOn > on) break;
    if (change.kind === 'leave-started') onLeave = true;
    // A new term starts at work; `ended` is the last day and is still on leave.
    else if (change.kind === 'leave-ended' || change.kind === 'rehired')
      onLeave = false;
  }
  return onLeave;
}

/**
 * The value of a dated attribute on `on`: the latest change on or before it,
 * else the value before the first change, else the current value.
 */
function valueOn(
  history: EmploymentChange[],
  kind: EmploymentChangeKind,
  on: IsoDate,
  current: string | null,
): string | null {
  const ofKind = history.filter((change) => change.kind === kind);
  if (ofKind.length === 0) return current;
  let value = ofKind[0].fromValue;
  for (const change of ofKind) {
    if (change.effectiveOn > on) break;
    value = change.toValue;
  }
  return value;
}

/**
 * The only writer of employment records. Construct it from a trusted
 * `{ tenantId, profileId }` actor the application has already authorized.
 * Every mutation runs in one transaction, appends a dated
 * {@link EmploymentChange} attributed to the actor, and delivers its event
 * after the transaction commits. Dates are calendar dates (`YYYY-MM-DD`).
 */
export class EmploymentService extends HrService {
  private async load(db: DatabaseInterface, id: string): Promise<Employment> {
    const employments = await EmploymentCollection.create({ db });
    const [employment] = await employments.list({
      where: { tenantId: this.actor.tenantId, id: this.id('employmentId', id) },
      limit: 1,
    });
    if (!employment)
      throw new HrError('HR_NOT_FOUND', 'Employment not found in this tenant.');
    return employment;
  }

  private async one(
    where: Record<string, unknown>,
    db: DatabaseInterface = this.db,
  ): Promise<Employment | null> {
    const employments = await EmploymentCollection.create({ db });
    const [employment] = await employments.list({
      where: { tenantId: this.actor.tenantId, ...where },
      limit: 1,
    });
    return employment ?? null;
  }

  private async termsOf(
    db: DatabaseInterface,
    employmentId: string,
  ): Promise<EmploymentTerm[]> {
    const terms = await EmploymentTermCollection.create({ db });
    const rows = await terms.list({
      where: { tenantId: this.actor.tenantId, employmentId },
    });
    return rows.sort((a, b) =>
      a.startedOn < b.startedOn ? -1 : a.startedOn > b.startedOn ? 1 : 0,
    );
  }

  private async changesOf(
    db: DatabaseInterface,
    employmentId: string,
  ): Promise<EmploymentChange[]> {
    const changes = await EmploymentChangeCollection.create({ db });
    return inHistoryOrder(
      await changes.list({
        where: { tenantId: this.actor.tenantId, employmentId },
      }),
    );
  }

  /**
   * Append a change. Creation instants are strictly increasing within one
   * employment (writes are serialized per tenant), so same-day changes replay
   * in the order they were recorded.
   */
  private async record(
    db: DatabaseInterface,
    employmentId: string,
    change: {
      kind: EmploymentChangeKind;
      effectiveOn: IsoDate;
      fromValue?: string | null;
      toValue?: string | null;
      note?: string;
    },
  ): Promise<void> {
    const changes = await EmploymentChangeCollection.create({ db });
    const latest = (
      await changes.list({
        where: { tenantId: this.actor.tenantId, employmentId },
      })
    ).reduce((max, row) => Math.max(max, createdTime(row)), 0);
    await insertHr(EmploymentChange, db, {
      tenantId: this.actor.tenantId,
      employmentId,
      kind: change.kind,
      effectiveOn: change.effectiveOn,
      fromValue: change.fromValue ?? null,
      toValue: change.toValue ?? null,
      note: change.note ?? '',
      actorProfileId: this.actor.profileId,
      created_at: new Date(Math.max(Date.now(), latest + 1)),
    });
  }

  /**
   * The term a dated change belongs to, with `effectiveOn` inside it: the
   * latest term, which is the open one until an end is recorded and the final
   * one (up to its last day) afterwards. The stored status plays no part, so
   * a change dated inside a notice period is accepted.
   *
   * @throws HrError `HR_INVALID` before the term started, `HR_STATUS_TRANSITION` after its last day
   */
  private async latestTerm(
    db: DatabaseInterface,
    employment: Employment,
    effectiveOn: IsoDate,
  ): Promise<EmploymentTerm> {
    const term = (await this.termsOf(db, employment.id as string)).at(-1);
    if (!term)
      throw new HrError('HR_STATUS_TRANSITION', 'The employment has no term.');
    if (effectiveOn < term.startedOn)
      throw new HrError(
        'HR_INVALID',
        `${effectiveOn} is before the current term started (${term.startedOn}).`,
      );
    if (term.endedOn !== null && effectiveOn > term.endedOn)
      throw new HrError(
        'HR_STATUS_TRANSITION',
        `The employment ended on ${term.endedOn}; rehire it first.`,
      );
    return term;
  }

  private async notBeforeLatest(
    db: DatabaseInterface,
    employmentId: string,
    kinds: readonly EmploymentChangeKind[],
    effectiveOn: IsoDate,
  ): Promise<void> {
    const latest = (await this.changesOf(db, employmentId))
      .filter((change) => kinds.includes(change.kind))
      .at(-1);
    if (latest && effectiveOn < latest.effectiveOn)
      throw new HrError(
        'HR_INVALID',
        `${effectiveOn} is earlier than the latest recorded change (${latest.effectiveOn}).`,
      );
  }

  /**
   * A login is exclusive to the employment that stores it until it is
   * explicitly unlinked there, whatever that employment's stored status. An
   * ended employment keeps its login through its notice period and after, so
   * two employments never share one and `findByUser(userId, on)` cannot be
   * ambiguous through the service.
   */
  private async loginFree(
    db: DatabaseInterface,
    userId: string,
    employmentId: string | null,
  ): Promise<void> {
    const employments = await EmploymentCollection.create({ db });
    const linked = await employments.list({
      where: { tenantId: this.actor.tenantId, userId },
    });
    if (linked.some((other) => other.id !== employmentId))
      throw new HrError(
        'HR_INVALID',
        'This login is already linked to another employment; unlink it there first.',
      );
  }

  private transition(employment: Employment, to: EmploymentStatus): void {
    if (!EMPLOYMENT_STATUS_TRANSITIONS[employment.status]?.includes(to))
      throw new HrError(
        'HR_STATUS_TRANSITION',
        `An employment cannot go from '${employment.status}' to '${to}'.`,
      );
    employment.status = to;
  }

  /**
   * Employ a person: creates the employment, its first term and a `hired`
   * change. A profile has one employment per tenant, so a person who worked
   * here before is rehired instead.
   *
   * @throws HrError `HR_ALREADY_EMPLOYED`, `HR_EMPLOYEE_NUMBER_TAKEN`, `HR_INVALID` (including a login already linked to another employment, ended or not: unlink it there first)
   */
  async hire(input: HireInput): Promise<Employment> {
    const profileId = this.id('profileId', input?.profileId);
    const employeeNumber =
      typeof input.employeeNumber === 'string'
        ? input.employeeNumber.trim()
        : '';
    if (!employeeNumber)
      throw new HrError('HR_INVALID', 'employeeNumber is required.');
    const startedOn = assertIsoDate('startedOn', input.startedOn);
    const workerType = workerTypeOf(input.workerType ?? 'employee');
    const position = positionOf(input.position);
    const userId = this.optionalId('userId', input.userId);
    const employerProfileId = this.optionalId(
      'employerProfileId',
      input.employerProfileId,
    );
    const id = await this.transact(async (db, queue) => {
      if (await this.one({ profileId }, db))
        throw new HrError(
          'HR_ALREADY_EMPLOYED',
          'This profile already has an employment in this tenant; rehire it instead.',
        );
      if (await this.one({ employeeNumber }, db))
        throw new HrError(
          'HR_EMPLOYEE_NUMBER_TAKEN',
          `Employee number '${employeeNumber}' is already used in this tenant.`,
        );
      if (userId) await this.loginFree(db, userId, null);
      const employment = await insertHr(Employment, db, {
        tenantId: this.actor.tenantId,
        profileId,
        userId,
        employerProfileId,
        employeeNumber,
        workerType,
        position,
        status: 'active',
      });
      const employmentId = employment.id as string;
      await insertHr(EmploymentTerm, db, {
        tenantId: this.actor.tenantId,
        employmentId,
        startedOn,
      });
      await this.record(db, employmentId, {
        kind: 'hired',
        effectiveOn: startedOn,
      });
      queue({
        type: 'employment.hired',
        employment,
        effectiveOn: startedOn,
        at: new Date(),
        byProfileId: this.actor.profileId,
      });
      return employmentId;
    });
    return this.get(id);
  }

  /**
   * End an employment: closes the open term on `endedOn` (the last day
   * employed, inclusive) and, in the same transaction, revokes its
   * employment-scoped qualifications from the day after, so they are still
   * good on the last day. `endedOn` cannot be earlier than a position,
   * worker-type or leave change already recorded in the term.
   *
   * `endedOn` may be ahead of the day the end is recorded (a notice period).
   * The stored status becomes `ended` at once, meaning "an end has been
   * recorded": the person is still employed up to and including `endedOn`,
   * so ask by date with {@link check}, {@link employedOn}, {@link asOf} or
   * `findByUser(userId, on)`. Position, worker-type and leave changes dated
   * inside the final term are still accepted.
   *
   * @throws HrError `HR_STATUS_TRANSITION` when already ended, `HR_INVALID`, `HR_NOT_FOUND`
   */
  async end(
    employmentId: string,
    input: EndEmploymentInput,
  ): Promise<Employment> {
    const endedOn = assertIsoDate('endedOn', input?.endedOn);
    const reason = noteOf(input.reason);
    const id = await this.transact(async (db, queue) => {
      const employment = await this.load(db, employmentId);
      this.transition(employment, 'ended');
      const term = await this.latestTerm(db, employment, endedOn);
      if (term.endedOn !== null)
        throw new HrError(
          'HR_STATUS_TRANSITION',
          'The employment has no open term.',
        );
      await this.notBeforeLatest(
        db,
        employment.id as string,
        TERM_CHANGE_KINDS,
        endedOn,
      );
      term.endedOn = endedOn;
      term.endReason = reason;
      await persistHr(term);
      await persistHr(employment);
      await this.record(db, employment.id as string, {
        kind: 'ended',
        effectiveOn: endedOn,
        note: reason,
      });
      await revokeEmploymentQualifications(
        db,
        this.actor,
        employment.id as string,
        addDays(endedOn, 1),
        queue,
      );
      queue({
        type: 'employment.ended',
        employment,
        effectiveOn: endedOn,
        at: new Date(),
        byProfileId: this.actor.profileId,
      });
      return employment.id as string;
    });
    return this.get(id);
  }

  /**
   * Rehire an ended employment: adds a term to the same row, so the
   * employment id stays stable. The new term cannot start before a position,
   * worker-type or leave change already recorded. The employment keeps the
   * login it stored, which no other employment can have taken meanwhile.
   *
   * @throws HrError `HR_STATUS_TRANSITION` unless ended, `HR_TERM_OVERLAP`, `HR_INVALID`, `HR_NOT_FOUND`
   */
  async rehire(employmentId: string, input: RehireInput): Promise<Employment> {
    const startedOn = assertIsoDate('startedOn', input?.startedOn);
    const workerType =
      input.workerType === undefined
        ? undefined
        : workerTypeOf(input.workerType);
    const position =
      input.position === undefined ? undefined : positionOf(input.position);
    const id = await this.transact(async (db, queue) => {
      const employment = await this.load(db, employmentId);
      if (employment.status !== 'ended')
        throw new HrError(
          'HR_STATUS_TRANSITION',
          `Only an ended employment can be rehired; this one is '${employment.status}'.`,
        );
      const id = employment.id as string;
      const previous = await this.termsOf(db, id);
      const overlapping = previous.find(
        (term) => term.endedOn === null || startedOn <= term.endedOn,
      );
      if (overlapping)
        throw new HrError(
          'HR_TERM_OVERLAP',
          `A rehire must start after the previous term ended (${overlapping.endedOn ?? 'still open'}).`,
        );
      await this.notBeforeLatest(db, id, TERM_CHANGE_KINDS, startedOn);
      // Backstop: the service never lets a stored login be linked elsewhere.
      if (employment.userId) await this.loginFree(db, employment.userId, id);
      const from = {
        position: employment.position,
        workerType: employment.workerType,
      };
      this.transition(employment, 'active');
      if (position !== undefined) employment.position = position;
      if (workerType !== undefined) employment.workerType = workerType;
      await persistHr(employment);
      await insertHr(EmploymentTerm, db, {
        tenantId: this.actor.tenantId,
        employmentId: id,
        startedOn,
      });
      await this.record(db, id, { kind: 'rehired', effectiveOn: startedOn });
      if (employment.position !== from.position)
        await this.record(db, id, {
          kind: 'position-changed',
          effectiveOn: startedOn,
          fromValue: from.position,
          toValue: employment.position,
        });
      if (employment.workerType !== from.workerType)
        await this.record(db, id, {
          kind: 'worker-type-changed',
          effectiveOn: startedOn,
          fromValue: from.workerType,
          toValue: employment.workerType,
        });
      queue({
        type: 'employment.rehired',
        employment,
        effectiveOn: startedOn,
        at: new Date(),
        byProfileId: this.actor.profileId,
      });
      return id;
    });
    return this.get(id);
  }

  /**
   * Record a new position from `effectiveOn`. The employment row holds the
   * latest value; the change row carries the old and new ones.
   *
   * `effectiveOn` must fall inside the latest term. Once an end has been
   * recorded that is the final term, up to and including its `endedOn`, so a
   * change during a notice period is accepted; the stored status stays
   * `ended`.
   *
   * @throws HrError `HR_STATUS_TRANSITION` when `effectiveOn` is after the last day of an ended employment; `HR_INVALID` for a no-op, a date before the term started or before the latest position change; `HR_NOT_FOUND`
   */
  async changePosition(
    employmentId: string,
    input: ChangePositionInput,
  ): Promise<Employment> {
    const effectiveOn = assertIsoDate('effectiveOn', input?.effectiveOn);
    const position = positionOf(input.position);
    const note = noteOf(input.note);
    const id = await this.transact(async (db, queue) => {
      const employment = await this.load(db, employmentId);
      const id = employment.id as string;
      await this.latestTerm(db, employment, effectiveOn);
      if (employment.position === position)
        throw new HrError(
          'HR_INVALID',
          'The employment already has this position.',
        );
      await this.notBeforeLatest(db, id, ['position-changed'], effectiveOn);
      const fromValue = employment.position;
      employment.position = position;
      await persistHr(employment);
      await this.record(db, id, {
        kind: 'position-changed',
        effectiveOn,
        fromValue,
        toValue: position,
        note,
      });
      queue({
        type: 'employment.position-changed',
        employment,
        effectiveOn,
        at: new Date(),
        byProfileId: this.actor.profileId,
      });
      return id;
    });
    return this.get(id);
  }

  /**
   * Record a new worker type from `effectiveOn`. The employment row holds the
   * latest value; the change row carries the old and new ones.
   *
   * `effectiveOn` must fall inside the latest term. Once an end has been
   * recorded that is the final term, up to and including its `endedOn`, so a
   * change during a notice period is accepted; the stored status stays
   * `ended`.
   *
   * @throws HrError `HR_STATUS_TRANSITION` when `effectiveOn` is after the last day of an ended employment; `HR_INVALID` for a no-op, a bad value, a date before the term started or before the latest worker-type change; `HR_NOT_FOUND`
   */
  async changeWorkerType(
    employmentId: string,
    input: ChangeWorkerTypeInput,
  ): Promise<Employment> {
    const effectiveOn = assertIsoDate('effectiveOn', input?.effectiveOn);
    const workerType = workerTypeOf(input.workerType);
    const note = noteOf(input.note);
    const id = await this.transact(async (db, queue) => {
      const employment = await this.load(db, employmentId);
      const id = employment.id as string;
      await this.latestTerm(db, employment, effectiveOn);
      if (employment.workerType === workerType)
        throw new HrError(
          'HR_INVALID',
          'The employment already has this worker type.',
        );
      await this.notBeforeLatest(db, id, ['worker-type-changed'], effectiveOn);
      const fromValue = employment.workerType;
      employment.workerType = workerType;
      await persistHr(employment);
      await this.record(db, id, {
        kind: 'worker-type-changed',
        effectiveOn,
        fromValue,
        toValue: workerType,
        note,
      });
      queue({
        type: 'employment.worker-type-changed',
        employment,
        effectiveOn,
        at: new Date(),
        byProfileId: this.actor.profileId,
      });
      return id;
    });
    return this.get(id);
  }

  private async leave(
    employmentId: string,
    input: LeaveInput,
    to: 'active' | 'on-leave',
  ): Promise<Employment> {
    const effectiveOn = assertIsoDate('effectiveOn', input?.effectiveOn);
    const note = noteOf(input.note);
    const kind = to === 'on-leave' ? 'leave-started' : 'leave-ended';
    const id = await this.transact(async (db, queue) => {
      const employment = await this.load(db, employmentId);
      const id = employment.id as string;
      if (employment.status === 'ended') {
        // An end is recorded: the stored status no longer says whether the
        // person is on leave, so the final term's replayed history decides,
        // and the status stays `ended` (`ended → active` is only a rehire).
        await this.latestTerm(db, employment, effectiveOn);
        await this.notBeforeLatest(db, id, LEAVE_CHANGE_KINDS, effectiveOn);
        const onLeave = onLeaveOn(await this.changesOf(db, id), effectiveOn);
        if (onLeave === (to === 'on-leave'))
          throw new HrError(
            'HR_STATUS_TRANSITION',
            onLeave
              ? `The employment is already on leave on ${effectiveOn}.`
              : `The employment is not on leave on ${effectiveOn}.`,
          );
      } else {
        this.transition(employment, to);
        await this.latestTerm(db, employment, effectiveOn);
        await this.notBeforeLatest(db, id, LEAVE_CHANGE_KINDS, effectiveOn);
        await persistHr(employment);
      }
      await this.record(db, id, { kind, effectiveOn, note });
      queue({
        type: `employment.${kind}`,
        employment,
        effectiveOn,
        at: new Date(),
        byProfileId: this.actor.profileId,
      });
      return id;
    });
    return this.get(id);
  }

  /**
   * Place an employment on leave from `effectiveOn`. A person on leave is
   * still employed.
   *
   * Once an end has been recorded, leave dated inside the final term (up to
   * and including its `endedOn`) is still accepted: it is recorded as a
   * change row, the stored status stays `ended`, and whether the person is
   * already on leave is decided by replaying the history as of `effectiveOn`.
   *
   * @throws HrError `HR_STATUS_TRANSITION` when already on leave, or when `effectiveOn` is after the last day of an ended employment; `HR_INVALID` for a date before the term started or before the latest leave change; `HR_NOT_FOUND`
   */
  async placeOnLeave(
    employmentId: string,
    input: LeaveInput,
  ): Promise<Employment> {
    return this.leave(employmentId, input, 'on-leave');
  }

  /**
   * Return an employment from leave; `effectiveOn` is the first day back.
   *
   * Once an end has been recorded, a return dated inside the final term (up
   * to and including its `endedOn`) is still accepted: it is recorded as a
   * change row, the stored status stays `ended`, and whether the person is
   * on leave is decided by replaying the history as of `effectiveOn`.
   *
   * @throws HrError `HR_STATUS_TRANSITION` unless on leave, or when `effectiveOn` is after the last day of an ended employment; `HR_INVALID` for a date before the term started or before the latest leave change; `HR_NOT_FOUND`
   */
  async returnFromLeave(
    employmentId: string,
    input: LeaveInput,
  ): Promise<Employment> {
    return this.leave(employmentId, input, 'active');
  }

  private async login(
    employmentId: string,
    userId: string | null,
    input: LoginLinkInput,
  ): Promise<Employment> {
    const effectiveOn = assertIsoDate('effectiveOn', input?.effectiveOn);
    const id = await this.transact(async (db) => {
      const employment = await this.load(db, employmentId);
      const id = employment.id as string;
      if (employment.userId === userId)
        throw new HrError(
          'HR_INVALID',
          userId
            ? 'This login is already linked to the employment.'
            : 'The employment has no linked login.',
        );
      if (userId) await this.loginFree(db, userId, id);
      const fromValue = employment.userId;
      employment.userId = userId;
      await persistHr(employment);
      await this.record(db, id, {
        kind: userId ? 'login-linked' : 'login-unlinked',
        effectiveOn,
        fromValue,
        toValue: userId,
      });
      return id;
    });
    return this.get(id);
  }

  /**
   * Link a login (`smrt-users:User` id) to an employment, replacing any
   * previous one. Grants nothing by itself: permissions stay with smrt-users.
   * A login belongs to one employment at a time and stays with it, ended or
   * not, until {@link unlinkLogin} clears it there.
   *
   * The link takes effect at once, whatever `effectiveOn` says: the date is
   * only recorded on the change row, and login links are not replayed by
   * {@link asOf} or `findByUser(userId, on)`.
   *
   * @throws HrError `HR_INVALID` when already linked to this login, or to another employment (unlink it there first); `HR_NOT_FOUND`
   */
  async linkLogin(
    employmentId: string,
    userId: string,
    input: LoginLinkInput,
  ): Promise<Employment> {
    return this.login(employmentId, this.id('userId', userId), input);
  }

  /**
   * Clear an employment's login, which frees it for another employment. Works
   * on an ended employment too. The login is cleared at once, whatever
   * `effectiveOn` says; a future date does not keep it linked until then.
   *
   * @throws HrError `HR_INVALID` when no login is linked, `HR_NOT_FOUND`
   */
  async unlinkLogin(
    employmentId: string,
    input: LoginLinkInput,
  ): Promise<Employment> {
    return this.login(employmentId, null, input);
  }

  /**
   * One employment in the actor's tenant.
   *
   * @throws HrError `HR_NOT_FOUND` when it does not exist in this tenant
   */
  async get(employmentId: string): Promise<Employment> {
    return this.scope(() => this.load(this.db, employmentId));
  }

  /** The profile's employment in this tenant (ended or not), or null. */
  async findByProfile(profileId: string): Promise<Employment | null> {
    if (typeof profileId !== 'string' || !profileId.trim()) return null;
    const id = this.identity(profileId.trim());
    return this.scope(() => this.one({ profileId: id }));
  }

  /** The employment with this employee number in this tenant, or null. */
  async findByEmployeeNumber(
    employeeNumber: string,
  ): Promise<Employment | null> {
    if (typeof employeeNumber !== 'string' || !employeeNumber.trim())
      return null;
    return this.scope(() =>
      this.one({ employeeNumber: employeeNumber.trim() }),
    );
  }

  /**
   * The employment linked to a login. Fails closed: null when there is none,
   * or when more than one matches (the service keeps a login on one
   * employment, so that takes rows written some other way).
   *
   * With `on`, the answer comes from the dated terms: the employment linked
   * to the login that has a term covering `on`, whatever its stored status.
   * Without `on`, it is the linked employment whose stored status is not
   * `ended`, which stops resolving as soon as an end is recorded. A host that
   * records end dates ahead of time (a notice period) should pass the date,
   * or the worker is locked out before their last day.
   *
   * @throws HrError `HR_INVALID` when `on` is given and is not a calendar date
   */
  async findByUser(userId: string, on?: IsoDate): Promise<Employment | null> {
    const date = on === undefined ? null : assertIsoDate('on', on);
    if (typeof userId !== 'string' || !userId.trim()) return null;
    const id = this.identity(userId.trim());
    return this.scope(async () => {
      const employments = await EmploymentCollection.create({ db: this.db });
      const linked = await employments.list({
        where: { tenantId: this.actor.tenantId, userId: id },
      });
      const matching: Employment[] = [];
      for (const employment of linked) {
        const matches =
          date === null
            ? employment.status !== 'ended'
            : (await this.termsOf(this.db, employment.id as string)).some(
                (term) => dateWithin(date, term.startedOn, term.endedOn),
              );
        if (matches) matching.push(employment);
      }
      return matching.length === 1 ? matching[0] : null;
    });
  }

  /** Everyone with a term covering `on`, including people on leave. */
  async employedOn(on: IsoDate): Promise<Employment[]> {
    const date = assertIsoDate('on', on);
    return this.scope(() => employmentsOn(this.db, this.actor.tenantId, date));
  }

  /**
   * Whether a profile is employed on a date. Answered from terms, never from
   * the stored status; `onLeave` is computed as of `on`, so past dates answer
   * correctly.
   */
  async check(profileId: string, on: IsoDate): Promise<EmploymentCheck> {
    const date = assertIsoDate('on', on);
    if (typeof profileId !== 'string' || !profileId.trim())
      return { ok: false, reason: 'not-employed' };
    const id = this.identity(profileId.trim());
    return this.scope(async () => {
      const employment = await this.one({ profileId: id });
      if (!employment) return { ok: false, reason: 'not-employed' };
      const employmentId = employment.id as string;
      const terms = await this.termsOf(this.db, employmentId);
      if (terms.length === 0) return { ok: false, reason: 'not-employed' };
      if (!terms.some((term) => dateWithin(date, term.startedOn, term.endedOn)))
        return {
          ok: false,
          reason: date < terms[0].startedOn ? 'not-started' : 'ended',
        };
      return {
        ok: true,
        employmentId,
        onLeave: onLeaveOn(await this.changesOf(this.db, employmentId), date),
      };
    });
  }

  /**
   * An employment's terms, oldest first.
   *
   * @throws HrError `HR_NOT_FOUND` when the employment is not in this tenant
   */
  async terms(employmentId: string): Promise<EmploymentTerm[]> {
    return this.scope(async () => {
      const employment = await this.load(this.db, employmentId);
      return this.termsOf(this.db, employment.id as string);
    });
  }

  /**
   * An employment's dated changes, by effective date and then in the order
   * they were recorded.
   *
   * @throws HrError `HR_NOT_FOUND` when the employment is not in this tenant
   */
  async history(employmentId: string): Promise<EmploymentChange[]> {
    return this.scope(async () => {
      const employment = await this.load(this.db, employmentId);
      return this.changesOf(this.db, employment.id as string);
    });
  }

  /**
   * An employment's position, worker type and standing on one date, replayed
   * from the change history. Before the first term the values are those at
   * hire and `employed` is false.
   *
   * @throws HrError `HR_NOT_FOUND` when the employment is not in this tenant
   */
  async asOf(employmentId: string, on: IsoDate): Promise<EmploymentAsOf> {
    const date = assertIsoDate('on', on);
    return this.scope(async () => {
      const employment = await this.load(this.db, employmentId);
      const id = employment.id as string;
      const history = await this.changesOf(this.db, id);
      const employed = (await this.termsOf(this.db, id)).some((term) =>
        dateWithin(date, term.startedOn, term.endedOn),
      );
      return {
        position: valueOn(
          history,
          'position-changed',
          date,
          employment.position,
        ),
        workerType:
          valueOn(
            history,
            'worker-type-changed',
            date,
            employment.workerType,
          ) ?? employment.workerType,
        employed,
        onLeave: employed && onLeaveOn(history, date),
      };
    });
  }
}
