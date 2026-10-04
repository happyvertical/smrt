import type { DatabaseInterface } from '@happyvertical/sql';
import { addDays, addMonths, assertIsoDate, dateWithin } from '../dates.js';
import {
  EmploymentCollection,
  EmploymentTermCollection,
} from '../employment/models.js';
import { employmentsOn } from '../employment/queries.js';
import { type HrEventQueue, HrService } from '../service-base.js';
import {
  type HeldQualificationChangeKind,
  type HeldQualificationEventType,
  type HeldQualificationStatus,
  HrError,
  type IsoDate,
  type QualificationCheck,
  type QualificationKind,
  type QualificationScope,
} from '../types.js';
import { insertHr, persistHr } from '../write.js';
import { EMPLOYMENT_ENDED_REASON } from './internal.js';
import {
  HeldQualification,
  HeldQualificationChange,
  HeldQualificationChangeCollection,
  HeldQualificationCollection,
  Qualification,
  QualificationCollection,
} from './models.js';

/** Input for {@link QualificationService.define} and {@link QualificationService.seed}. */
export interface DefineQualificationInput {
  /** Lowercase kebab-case, unique per tenant: `first-aid`. */
  key: string;
  /** Display name. */
  name: string;
  /** What the qualification is. */
  kind: QualificationKind;
  /** Who issues it; free text. */
  issuingBody?: string;
  /** Whether held qualifications of this kind expire. Defaults to false. */
  expires?: boolean;
  /** Default validity in months; only meaningful when `expires` is true. */
  validityMonths?: number | null;
  /** Defaults to `employment` for kind `authorization`, else `person`. */
  scope?: QualificationScope;
}

/** Input for {@link QualificationService.update}. Key and scope never change. */
export interface UpdateQualificationInput {
  /** New display name. */
  name?: string;
  /** New issuing body. */
  issuingBody?: string;
  /** Whether new grants expire; turning it off clears `validityMonths`. */
  expires?: boolean;
  /** New default validity in months, or null for none. */
  validityMonths?: number | null;
  /** Deactivate (or reactivate) the definition; inactive ones cannot be granted. */
  isActive?: boolean;
}

/** Options for {@link QualificationService.list}. */
export interface ListQualificationsOptions {
  /** Include deactivated definitions. Defaults to false. */
  includeInactive?: boolean;
}

/** Input for {@link QualificationService.grant}. */
export interface GrantQualificationInput {
  /** The definition being granted. */
  qualificationId: string;
  /** The person receiving it. */
  profileId: string;
  /** First day it is valid. */
  issuedOn: IsoDate;
  /** Last day it is valid (inclusive). Defaults from the definition's validity. */
  expiresOn?: IsoDate | null;
  /** Certificate or ticket number; free text. */
  certificateNumber?: string;
  /** Optional `smrt-assets:Asset` id of the scanned document. */
  documentAssetId?: string | null;
  /** Record the actor as having verified the document, now. */
  verified?: boolean;
  /** For an employment-scoped definition; resolved from the profile when omitted. */
  employmentId?: string | null;
}

/** Input for {@link QualificationService.renew}. */
export interface RenewQualificationInput {
  /** First day the renewal is valid. */
  issuedOn: IsoDate;
  /** Last day it is valid (inclusive). Defaults from the definition's validity. */
  expiresOn?: IsoDate | null;
  /** Certificate or ticket number of the renewal. */
  certificateNumber?: string;
  /** Optional `smrt-assets:Asset` id of the renewal's document. */
  documentAssetId?: string | null;
  /** Record the actor as having verified the document, now. */
  verified?: boolean;
}

/** Input for suspending or revoking a held qualification. */
export interface HeldQualificationReasonInput {
  /** The calendar date the change takes effect (that day included). */
  effectiveOn: IsoDate;
  /** Why; required. */
  reason: string;
}

/** Input for {@link QualificationService.reinstate}. */
export interface ReinstateQualificationInput {
  /** The calendar date the qualification is good again (that day included). */
  effectiveOn: IsoDate;
  /** Optional note. */
  reason?: string;
}

/** Input for {@link QualificationService.verify}. */
export interface VerifyQualificationInput {
  /**
   * `smrt-assets:Asset` id of the document to attach or replace; null removes
   * it, and omitting it keeps the current one.
   */
  documentAssetId?: string | null;
}

/** Options for {@link QualificationService.holders}. */
export interface QualificationHoldersOptions {
  /** Only people with an employment term covering the date. */
  employedOnly?: boolean;
}

/** Options for {@link QualificationService.expiringWithin}. */
export interface ExpiringQualificationsOptions {
  /** Only people with an employment term covering `today`. */
  employedOnly?: boolean;
}

/** Status of a held qualification computed for one calendar date. */
export type HeldQualificationStatusOn =
  | HeldQualificationStatus
  | 'not-yet-issued';

/** One row of {@link QualificationService.listForProfile}. */
export interface ProfileQualification {
  /** What the person holds. */
  held: HeldQualification;
  /** Its definition. */
  qualification: Qualification;
  /** Status computed for the requested date. */
  status: HeldQualificationStatusOn;
}

/**
 * A small, generic starter list an application may pass to
 * {@link QualificationService.seed}. Illustrative only: validity periods and
 * what a restriction means are the application's and its jurisdiction's call.
 */
export const SUGGESTED_QUALIFICATIONS: readonly DefineQualificationInput[] =
  Object.freeze([
    Object.freeze({
      key: 'first-aid',
      name: 'First aid',
      kind: 'certification',
      expires: true,
      validityMonths: 36,
    } as const),
    Object.freeze({
      key: 'site-orientation',
      name: 'Site orientation',
      kind: 'training',
    } as const),
    Object.freeze({
      key: 'youth-worker',
      name: 'Youth worker',
      kind: 'restriction',
    } as const),
  ]);

/** The cutoff an already closed employment term puts on a qualification. */
function employmentEnd(endsOn: IsoDate | null): Revocation | null {
  return endsOn === null
    ? null
    : { on: addDays(endsOn, 1), reason: EMPLOYMENT_ENDED_REASON };
}

const KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KINDS: readonly QualificationKind[] = [
  'ticket',
  'certification',
  'authorization',
  'training',
  'restriction',
];
const SCOPES: readonly QualificationScope[] = ['person', 'employment'];
const IN_CHUNK = 500;

type Definition = Required<DefineQualificationInput>;

function invalid(message: string): HrError {
  return new HrError('HR_INVALID', message);
}

function text(fieldName: string, value: unknown, required = false): string {
  if (value == null && !required) return '';
  if (typeof value !== 'string') throw invalid(`${fieldName} must be text.`);
  const trimmed = value.trim();
  if (required && !trimmed) throw invalid(`${fieldName} is required.`);
  return trimmed;
}

function flag(fieldName: string, value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean')
    throw invalid(`${fieldName} must be true or false.`);
  return value;
}

function validity(expires: boolean, value: unknown): number | null {
  if (value == null) return null;
  if (!Number.isInteger(value) || (value as number) <= 0)
    throw invalid('validityMonths must be a positive whole number or null.');
  if (!expires)
    throw invalid(
      'validityMonths only applies to a qualification that expires.',
    );
  return value as number;
}

function normalizeDefinition(input: DefineQualificationInput): Definition {
  const key = text('key', input?.key, true);
  if (!KEY.test(key))
    throw invalid(`key must be lowercase kebab-case, got '${key}'.`);
  if (!KINDS.includes(input.kind))
    throw invalid(`kind must be one of ${KINDS.join(', ')}.`);
  const scope =
    input.scope ?? (input.kind === 'authorization' ? 'employment' : 'person');
  if (!SCOPES.includes(scope))
    throw invalid(`scope must be one of ${SCOPES.join(', ')}.`);
  const expires = flag('expires', input.expires, false);
  return {
    key,
    name: text('name', input.name, true),
    kind: input.kind,
    issuingBody: text('issuingBody', input.issuingBody),
    expires,
    validityMonths: validity(expires, input.validityMonths),
    scope,
  };
}

/** The last day a grant is valid, from the input or the definition's validity. */
function resolveExpiry(
  definition: Qualification,
  issuedOn: IsoDate,
  given: IsoDate | null | undefined,
): IsoDate | null {
  if (!definition.expires) {
    if (given != null)
      throw invalid(`'${definition.key}' does not expire; omit expiresOn.`);
    return null;
  }
  let expiresOn: IsoDate;
  if (given != null) expiresOn = assertIsoDate('expiresOn', given);
  else if (definition.validityMonths != null)
    expiresOn = addMonths(issuedOn, definition.validityMonths);
  else
    throw invalid(
      `'${definition.key}' expires and has no default validity; give expiresOn.`,
    );
  if (expiresOn < issuedOn)
    throw invalid('expiresOn must not be before issuedOn.');
  return expiresOn;
}

/**
 * Whether a row is revoked or suspended on a date, replayed from its dated
 * changes. Does not depend on the order of same-day changes: revocation is
 * terminal, and suspensions and reinstatements alternate.
 */
function standingOn(
  changes: readonly HeldQualificationChange[],
  on: IsoDate,
): 'revoked' | 'suspended' | null {
  let suspensions = 0;
  for (const change of changes) {
    if (change.effectiveOn > on) continue;
    if (change.kind === 'revoked') return 'revoked';
    if (change.kind === 'suspended') suspensions += 1;
    else if (change.kind === 'reinstated') suspensions -= 1;
  }
  return suspensions > 0 ? 'suspended' : null;
}

/**
 * Status of one row on a date, from its own dates and changes. Never trusts
 * the stored status.
 */
function statusOn(
  row: HeldQualification,
  changes: readonly HeldQualificationChange[],
  on: IsoDate,
): HeldQualificationStatusOn {
  if (row.issuedOn > on) return 'not-yet-issued';
  const standing = standingOn(changes, on);
  if (standing) return standing;
  if (row.expiresOn != null && on > row.expiresOn) return 'expired';
  return 'valid';
}

/**
 * Status of every row on a date, with a renewal chain sharing its standing:
 * a row that would be valid is revoked or suspended when a later row in its
 * chain (a renewal of it, or of that renewal) is revoked or suspended on the
 * date. Without this, revoking a renewal would be bypassed by the unexpired
 * row it renewed. `rows` must hold whole chains.
 */
function chainStatusesOn(
  rows: readonly HeldQualification[],
  changes: ReadonlyMap<string, readonly HeldQualificationChange[]>,
  on: IsoDate,
): Map<string, HeldQualificationStatusOn> {
  const renewalOf = new Map<string, HeldQualification>();
  for (const row of rows)
    if (row.renewalOfId) renewalOf.set(row.renewalOfId, row);
  const statuses = new Map<string, HeldQualificationStatusOn>();
  for (const row of rows) {
    const id = row.id as string;
    let status = statusOn(row, changes.get(id) ?? [], on);
    const seen = new Set([id]);
    let later = renewalOf.get(id);
    while (status !== 'revoked' && later && !seen.has(later.id as string)) {
      seen.add(later.id as string);
      const standing = standingOn(changes.get(later.id as string) ?? [], on);
      if (standing && (status === 'valid' || status === 'suspended'))
        status = standing;
      later = renewalOf.get(later.id as string);
    }
    statuses.set(id, status);
  }
  return statuses;
}

/**
 * Changes that suspend or lift a suspension. They are recorded in date order;
 * a revocation is terminal and may be recorded for any date.
 */
const SUSPENSION_KINDS: readonly HeldQualificationChangeKind[] = [
  'suspended',
  'reinstated',
];

/** A revocation: the day it takes effect and why. */
interface Revocation {
  /** First day revoked. */
  on: IsoDate;
  /** The reason recorded with it. */
  reason: string;
}

/** The revocation in force: the earliest one recorded, or null. */
function revocationOf(
  changes: readonly HeldQualificationChange[],
): Revocation | null {
  let earliest: HeldQualificationChange | null = null;
  for (const change of changes)
    if (
      change.kind === 'revoked' &&
      (earliest === null || change.effectiveOn < earliest.effectiveOn)
    )
      earliest = change;
  return earliest && { on: earliest.effectiveOn, reason: earliest.reason };
}

/** The date a revocation takes effect: the earliest one recorded, or null. */
function revokedFrom(
  changes: readonly HeldQualificationChange[],
): IsoDate | null {
  return revocationOf(changes)?.on ?? null;
}

/** The latest effective date among changes of the given kinds, or null. */
function latestOf(
  changes: readonly HeldQualificationChange[],
  kinds: readonly HeldQualificationChangeKind[],
): IsoDate | null {
  let latest: IsoDate | null = null;
  for (const change of changes)
    if (
      kinds.includes(change.kind) &&
      (latest === null || change.effectiveOn > latest)
    )
      latest = change.effectiveOn;
  return latest;
}

function createdTime(row: { created_at?: Date | string | null }): number {
  const time = row.created_at ? new Date(row.created_at).getTime() : 0;
  return Number.isNaN(time) ? 0 : time;
}

/** Among rows that are good on a date, the one that lasts longest. */
function longestLasting(rows: readonly HeldQualification[]): HeldQualification {
  return rows.reduce((best, row) => {
    if (best.expiresOn === row.expiresOn)
      return row.issuedOn > best.issuedOn ? row : best;
    if (best.expiresOn == null) return best;
    if (row.expiresOn == null) return row;
    return row.expiresOn > best.expiresOn ? row : best;
  });
}

/**
 * The only writer of qualification definitions and held qualifications, and
 * the gate ({@link QualificationService.check}) applications call before
 * letting a person do qualified work. Constructed from a trusted
 * tenant/profile actor the application has already authorized.
 *
 * Whether a qualification is good on a date is computed from `issuedOn`,
 * `expiresOn` and the dated change history, so past dates keep answering
 * correctly and expiry needs no scheduler. The stored status records the
 * last change made (a revocation or suspension stores at once, even when it
 * takes effect later), so every rule that asks about standing replays the
 * dated history instead, including the rules that decide whether a
 * qualification may be suspended, reinstated, revoked or renewed. A stored
 * `revoked` is final: later changes to such a row are change rows only. The
 * stored `expired` status is written only by
 * {@link QualificationService.sweepExpired}.
 */
export class QualificationService extends HrService {
  // ── Definitions ──────────────────────────────────────────────────────────

  /** Add a qualification definition; its key is unique per tenant. */
  async define(input: DefineQualificationInput): Promise<Qualification> {
    const definition = normalizeDefinition(input);
    const id = await this.transact(async (db) => {
      if (await this.byKey(db, definition.key))
        throw new HrError(
          'HR_QUALIFICATION_KEY_TAKEN',
          `A qualification with key '${definition.key}' already exists.`,
        );
      return (await this.insertDefinition(db, definition)).id as string;
    });
    return this.get(id);
  }

  /** Change a definition's descriptive fields; key and scope are immutable. */
  async update(
    qualificationId: string,
    input: UpdateQualificationInput,
  ): Promise<Qualification> {
    const id = this.id('qualificationId', qualificationId);
    if (input == null || typeof input !== 'object')
      throw invalid('update needs the fields to change.');
    await this.transact(async (db) => {
      const row = await this.definition(db, id);
      if (input.name !== undefined) row.name = text('name', input.name, true);
      if (input.issuingBody !== undefined)
        row.issuingBody = text('issuingBody', input.issuingBody);
      row.expires = flag('expires', input.expires, row.expires);
      row.isActive = flag('isActive', input.isActive, row.isActive);
      if (input.validityMonths !== undefined)
        row.validityMonths = validity(row.expires, input.validityMonths);
      else if (!row.expires) row.validityMonths = null;
      await persistHr(row);
    });
    return this.get(id);
  }

  /**
   * Create the definitions whose key is missing and leave existing rows
   * untouched. Returns one definition per input, in input order.
   */
  async seed(
    definitions: readonly DefineQualificationInput[],
  ): Promise<Qualification[]> {
    const wanted = definitions.map(normalizeDefinition);
    if (new Set(wanted.map((d) => d.key)).size !== wanted.length)
      throw invalid('Seed definitions must have distinct keys.');
    const ids = await this.transact(async (db) => {
      const result: string[] = [];
      for (const definition of wanted) {
        const row =
          (await this.byKey(db, definition.key)) ??
          (await this.insertDefinition(db, definition));
        result.push(row.id as string);
      }
      return result;
    });
    return this.scope(async () => {
      const collection = await QualificationCollection.create({ db: this.db });
      const rows = await collection.list({
        where: { tenantId: this.actor.tenantId },
      });
      const byId = new Map(rows.map((row) => [row.id as string, row]));
      return ids.map((id) => byId.get(id) as Qualification);
    });
  }

  /** The tenant's definitions ordered by key; active ones unless asked. */
  async list(
    options: ListQualificationsOptions = {},
  ): Promise<Qualification[]> {
    return this.scope(async () => {
      const collection = await QualificationCollection.create({ db: this.db });
      const rows = await collection.list({
        where: { tenantId: this.actor.tenantId },
        orderBy: 'key ASC',
      });
      return options.includeInactive ? rows : rows.filter((r) => r.isActive);
    });
  }

  /**
   * One definition by id.
   *
   * @throws HrError `HR_NOT_FOUND` outside the actor's tenant, `HR_INVALID` for a blank id
   */
  async get(qualificationId: string): Promise<Qualification> {
    const id = this.id('qualificationId', qualificationId);
    return this.scope(() => this.definition(this.db, id));
  }

  /** One definition by key, or null. */
  async findByKey(key: string): Promise<Qualification | null> {
    if (typeof key !== 'string' || !key.trim()) return null;
    return this.scope(() => this.byKey(this.db, key.trim()));
  }

  // ── Held qualifications ──────────────────────────────────────────────────

  /**
   * Record that a person holds a qualification from `issuedOn`.
   *
   * A person has one live grant of a qualification at a time, decided by
   * date: the grant is refused unless everything they already hold of it is
   * revoked effective on or before `issuedOn`. A lapsed ticket (swept or not)
   * is renewed, not granted again, and a revocation scheduled for a later
   * date does not free an earlier issue date.
   *
   * An employment-scoped grant dated inside a term whose end is already
   * recorded ends with that employment: the `employment-ended` revocation,
   * effective the day after the term's last day, is recorded in the same
   * transaction and the row is stored `revoked`.
   *
   * @throws HrError `HR_ALREADY_HELD` unless every earlier grant is revoked effective on or before `issuedOn` (renew the existing one instead), `HR_QUALIFICATION_SCOPE`, `HR_INVALID`, `HR_NOT_FOUND`
   */
  async grant(input: GrantQualificationInput): Promise<HeldQualification> {
    const qualificationId = this.id('qualificationId', input?.qualificationId);
    const profileId = this.id('profileId', input.profileId);
    const issuedOn = assertIsoDate('issuedOn', input.issuedOn);
    const givenEmploymentId = this.optionalId(
      'employmentId',
      input.employmentId,
    );
    const id = await this.transact(async (db, queue) => {
      const definition = await this.grantable(db, qualificationId);
      const expiresOn = resolveExpiry(definition, issuedOn, input.expiresOn);
      const { employmentId, endsOn } = await this.employmentFor(
        db,
        definition,
        profileId,
        givenEmploymentId,
        issuedOn,
      );
      const rows = await this.rows(db, { profileId, qualificationId });
      const [live] = await this.liveChains(db, rows, issuedOn, null);
      if (live)
        throw new HrError(
          'HR_ALREADY_HELD',
          live.revokedOn
            ? `This person holds '${definition.key}' until its revocation takes effect on ${live.revokedOn}; renew the existing one instead.`
            : `This person already holds '${definition.key}'; renew it instead.`,
        );
      const row = await this.insertHeld(db, queue, 'granted', {
        qualificationId,
        profileId,
        employmentId,
        revocation: employmentEnd(endsOn),
        issuedOn,
        expiresOn,
        renewalOfId: null,
        input,
      });
      return row.id as string;
    });
    return this.held(this.db, id);
  }

  /**
   * Renew a held qualification: a new row pointing at the old one. The old row
   * is not modified, so checks on past dates still answer from it. Only the
   * latest row of a chain can be renewed.
   *
   * The renewal is validated against the old row's dated history, not its
   * stored status: `issuedOn` cannot be earlier than the row's latest
   * suspension or reinstatement (the renewal would otherwise answer for dates
   * the history says were suspended), the row must not be suspended on
   * `issuedOn`, and it must not be revoked on or before `issuedOn`.
   *
   * A revocation recorded for a later date (a scheduled one, or the end of an
   * employment whose last day is ahead) does not stop a renewal: the
   * qualification is still in force, so a ticket that lapses first can be
   * renewed. The renewal carries the cutoff forward. It is stored `revoked`
   * with a revocation at the earlier of the old row's pending revocation
   * (with its reason) and, for an employment-scoped one inside a term whose
   * end is recorded, the day after the last day employed
   * (`employment-ended`); `held-qualification.renewed` and
   * `held-qualification.revoked` are both raised.
   *
   * @throws HrError `HR_STATUS_TRANSITION` when suspended on `issuedOn` (reinstate it first); `HR_ALREADY_HELD` when the person holds another grant outside this chain that is not revoked on or before `issuedOn`; `HR_INVALID` for a row revoked on or before `issuedOn`, an already renewed row, or an `issuedOn` before the row's own or before its latest suspension or reinstatement; `HR_NOT_FOUND`
   */
  async renew(
    heldQualificationId: string,
    input: RenewQualificationInput,
  ): Promise<HeldQualification> {
    const priorId = this.id('heldQualificationId', heldQualificationId);
    const issuedOn = assertIsoDate('issuedOn', input?.issuedOn);
    const id = await this.transact(async (db, queue) => {
      const prior = await this.held(db, priorId);
      const history =
        (await this.changesByHeld(db, [prior])).get(priorId) ?? [];
      // Revocation is terminal from the day it takes effect; until then the
      // qualification is in force and can be renewed. A stored `revoked` with
      // no dated revocation (a row written outside the service) has no day to
      // go by and is treated as revoked throughout.
      const pending = revocationOf(history);
      if (
        (pending !== null && pending.on <= issuedOn) ||
        (pending === null && prior.status === 'revoked')
      )
        throw invalid(
          'A qualification revoked on or before the renewal date cannot be renewed; grant a new one.',
        );
      const siblings = await this.rows(db, {
        profileId: prior.profileId,
        qualificationId: prior.qualificationId,
      });
      if (siblings.some((row) => row.renewalOfId === priorId))
        throw invalid(
          'This qualification was already renewed; renew the latest one.',
        );
      if (issuedOn < prior.issuedOn)
        throw invalid('A renewal cannot be issued before what it renews.');
      // A renewal starts out in good standing from its issue date, so it must
      // not reach back over a suspension the history records.
      const changedOn = latestOf(history, SUSPENSION_KINDS);
      if (changedOn !== null && issuedOn < changedOn)
        throw invalid(
          `A renewal cannot be issued before the latest suspension or reinstatement on ${changedOn}.`,
        );
      if (standingOn(history, issuedOn) === 'suspended')
        throw new HrError(
          'HR_STATUS_TRANSITION',
          'A suspended qualification cannot be renewed; reinstate it first.',
        );
      // Earlier rows of this chain are all renewed, so any other latest row
      // belongs to a different chain.
      if ((await this.liveChains(db, siblings, issuedOn, priorId)).length > 0)
        throw new HrError(
          'HR_ALREADY_HELD',
          'This person holds another grant of this qualification outside this renewal chain; renew that one, or revoke it first.',
        );
      const definition = await this.grantable(db, prior.qualificationId);
      const expiresOn = resolveExpiry(definition, issuedOn, input.expiresOn);
      const { employmentId, endsOn } = await this.employmentFor(
        db,
        definition,
        prior.profileId,
        prior.employmentId,
        issuedOn,
      );
      // The earlier cutoff wins; on the same day the employment end is the
      // reason kept.
      const ended = employmentEnd(endsOn);
      const row = await this.insertHeld(db, queue, 'renewed', {
        qualificationId: prior.qualificationId,
        profileId: prior.profileId,
        employmentId,
        revocation:
          ended !== null && (pending === null || ended.on <= pending.on)
            ? ended
            : pending,
        issuedOn,
        expiresOn,
        renewalOfId: priorId,
        input,
      });
      return row.id as string;
    });
    return this.held(this.db, id);
  }

  /**
   * Suspend a qualification from `effectiveOn` until it is reinstated. Act on
   * the latest row of a renewal chain: the whole chain shares its standing,
   * so the rows it renewed stop passing checks too.
   *
   * Whether it can be suspended is decided from the chain's dated history as
   * of `effectiveOn`, never from the stored status: it must be neither
   * suspended nor revoked on that day. A revocation recorded for a later date
   * (scheduled, or the end of an employment whose last day is ahead) does not
   * prevent it, and neither does a stored `expired`.
   *
   * `effectiveOn` may be any date from the chain's first issue date onward,
   * not before the chain's latest suspension or reinstatement. It may precede
   * the latest row's own issue date: with a renewal recorded ahead of time,
   * that is how the ticket in force today is suspended, and the renewal is
   * then suspended from its issue date until reinstated.
   *
   * The stored status becomes `suspended`, except on a row already stored
   * `revoked`, which keeps it: only the change row is added.
   *
   * @throws HrError `HR_INVALID` for a row that was renewed, a date outside that range or a bad input; `HR_STATUS_TRANSITION` when suspended or revoked on `effectiveOn`; `HR_NOT_FOUND`
   */
  async suspend(
    heldQualificationId: string,
    input: HeldQualificationReasonInput,
  ): Promise<HeldQualification> {
    return this.transition(heldQualificationId, 'suspended', {
      effectiveOn: input?.effectiveOn,
      reason: text('reason', input?.reason, true),
    });
  }

  /**
   * Lift a suspension from `effectiveOn`, which follows the same date rule as
   * {@link suspend}. The chain must be suspended on that day by its dated
   * history, and not yet revoked. The stored status becomes `valid` (or stays
   * `revoked` or `expired` when that was stored).
   *
   * @throws HrError `HR_INVALID` for a row that was renewed, a date before the suspension or a bad input; `HR_STATUS_TRANSITION` unless suspended on `effectiveOn`; `HR_NOT_FOUND`
   */
  async reinstate(
    heldQualificationId: string,
    input: ReinstateQualificationInput,
  ): Promise<HeldQualification> {
    return this.transition(heldQualificationId, 'reinstated', {
      effectiveOn: input?.effectiveOn,
      reason: text('reason', input?.reason),
    });
  }

  /**
   * Revoke a qualification from `effectiveOn`. Terminal: grant a new one
   * dated on or after it. Act on the latest row of a renewal chain: the rows
   * it renewed stop passing checks from the same date; dated before a renewal
   * recorded ahead of time, the renewal is revoked from its issue date.
   *
   * `effectiveOn` may be any date from the chain's first issue date onward,
   * whatever else is recorded: an urgent revocation may be dated before a
   * suspension recorded ahead of time, or before a revocation that has not
   * taken effect yet (a scheduled one, or the end of an employment whose last
   * day is ahead). The earliest revocation is the one in force. It is refused
   * only when the chain is already revoked on or before `effectiveOn`.
   *
   * The stored status becomes `revoked` at once, meaning a revocation has
   * been recorded; until `effectiveOn` the qualification still passes
   * {@link check}. A row already stored `revoked` is not saved again: the
   * earlier revocation is one more change row, and the event carries its
   * date.
   *
   * @throws HrError `HR_INVALID` for a row that was renewed, a date before the chain was issued or a bad input; `HR_STATUS_TRANSITION` when already revoked on or before `effectiveOn`; `HR_NOT_FOUND`
   */
  async revoke(
    heldQualificationId: string,
    input: HeldQualificationReasonInput,
  ): Promise<HeldQualification> {
    return this.transition(heldQualificationId, 'revoked', {
      effectiveOn: input?.effectiveOn,
      reason: text('reason', input?.reason, true),
    });
  }

  /**
   * Record that the actor has verified a held qualification's document, now.
   * Optionally attaches, replaces or removes the document. The status and the
   * dated history do not change, and no event is raised. Verification is not
   * a status, so it works whatever the standing, including on a row stored
   * `revoked` (which may still be in force until its revocation takes effect).
   *
   * @throws HrError `HR_INVALID`, `HR_NOT_FOUND`
   */
  async verify(
    heldQualificationId: string,
    input: VerifyQualificationInput = {},
  ): Promise<HeldQualification> {
    const id = this.id('heldQualificationId', heldQualificationId);
    if (input == null || typeof input !== 'object')
      throw invalid('verify takes an options object.');
    const documentAssetId =
      input.documentAssetId === undefined
        ? undefined
        : this.optionalId('documentAssetId', input.documentAssetId);
    await this.transact(async (db) => {
      const row = await this.held(db, id);
      if (documentAssetId !== undefined) row.documentAssetId = documentAssetId;
      row.verifiedByProfileId = this.actor.profileId;
      row.verifiedAt = new Date();
      await persistHr(row);
    });
    return this.held(this.db, id);
  }

  /**
   * Store the `expired` status on valid rows whose last day is before `today`.
   * The application calls this from its own scheduler; checks never depend on
   * it. Idempotent. Emits `held-qualification.expired`, and returns the row,
   * only for qualifications that were not renewed.
   */
  async sweepExpired(today: IsoDate): Promise<HeldQualification[]> {
    assertIsoDate('today', today);
    const ids = await this.transact(async (db, queue) => {
      const due = (
        await this.rows(db, { status: 'valid', 'expiresOn <': today })
      ).filter((row) => row.expiresOn != null);
      const superseded = await this.supersededIds(db, due);
      const emitted: string[] = [];
      for (const row of due) {
        const effectiveOn = addDays(row.expiresOn as IsoDate, 1);
        row.status = 'expired';
        await persistHr(row);
        await this.recordChange(db, row, 'expired', effectiveOn, '');
        if (superseded.has(row.id as string)) continue;
        this.announce(queue, 'held-qualification.expired', row, effectiveOn);
        emitted.push(row.id as string);
      }
      return emitted;
    });
    return this.scope(async () => {
      const rows = await this.rowsById(this.db, ids);
      return rows.sort(
        (a, b) =>
          (a.expiresOn ?? '').localeCompare(b.expiresOn ?? '') ||
          String(a.id).localeCompare(String(b.id)),
      );
    });
  }

  // ── Queries ──────────────────────────────────────────────────────────────

  /**
   * Whether a person holds a qualification on a calendar date. Computed from
   * issue and expiry dates and the dated change history, never from the stored
   * status alone, so it is correct for past dates and without the sweep. A
   * renewal chain shares its standing: while a renewal is revoked or
   * suspended, the row it renewed does not pass either. A blank profile or
   * qualification id is `not-held`.
   */
  async check(
    profileId: string,
    qualificationId: string,
    on: IsoDate,
  ): Promise<QualificationCheck> {
    assertIsoDate('on', on);
    const blank = (value: unknown) =>
      typeof value !== 'string' || !value.trim();
    if (blank(profileId) || blank(qualificationId))
      return { ok: false, reason: 'not-held' };
    const where = {
      profileId: this.id('profileId', profileId),
      qualificationId: this.id('qualificationId', qualificationId),
    };
    return this.scope(async () => {
      const rows = await this.rows(this.db, where);
      if (rows.length === 0) return { ok: false, reason: 'not-held' };
      const statuses = chainStatusesOn(
        rows,
        await this.changesByHeld(this.db, rows),
        on,
      );
      const good = rows.filter(
        (row) => statuses.get(row.id as string) === 'valid',
      );
      if (good.length > 0) {
        const best = longestLasting(good);
        return {
          ok: true,
          heldQualificationId: best.id as string,
          expiresOn: best.expiresOn,
        };
      }
      const issued = rows.filter((row) => row.issuedOn <= on);
      if (issued.length === 0) return { ok: false, reason: 'not-yet-issued' };
      const latest = issued.reduce((a, b) =>
        b.issuedOn > a.issuedOn ||
        (b.issuedOn === a.issuedOn && createdTime(b) >= createdTime(a))
          ? b
          : a,
      );
      return {
        ok: false,
        reason: statuses.get(latest.id as string) as
          | 'expired'
          | 'suspended'
          | 'revoked',
      };
    });
  }

  /**
   * One held qualification per person who passes {@link check} on `on`,
   * ordered by profile id.
   */
  async holders(
    qualificationId: string,
    on: IsoDate,
    options: QualificationHoldersOptions = {},
  ): Promise<HeldQualification[]> {
    assertIsoDate('on', on);
    const id = this.id('qualificationId', qualificationId);
    return this.scope(async () => {
      const rows = await this.rows(this.db, { qualificationId: id });
      const statuses = chainStatusesOn(
        rows,
        await this.changesByHeld(this.db, rows),
        on,
      );
      const employed = options?.employedOnly
        ? new Set(
            (await employmentsOn(this.db, this.actor.tenantId, on)).map(
              (employment) => employment.profileId,
            ),
          )
        : null;
      const good = new Map<string, HeldQualification[]>();
      for (const row of rows) {
        if (employed && !employed.has(row.profileId)) continue;
        if (statuses.get(row.id as string) !== 'valid') continue;
        good.set(row.profileId, [...(good.get(row.profileId) ?? []), row]);
      }
      return [...good.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, held]) => longestLasting(held));
    });
  }

  /**
   * Qualifications good on `today` (issued, and not suspended or revoked by
   * the dated history, exactly as {@link check} decides) whose last day falls
   * in `[today, today + days]`, soonest first. The stored status plays no
   * part. A qualification that was already renewed is left out, and
   * `employedOnly` keeps only people with an employment term covering `today`.
   */
  async expiringWithin(
    days: number,
    today: IsoDate,
    options: ExpiringQualificationsOptions = {},
  ): Promise<HeldQualification[]> {
    assertIsoDate('today', today);
    if (!Number.isInteger(days) || days < 0)
      throw invalid('days must be a whole number, zero or more.');
    return this.scope(async () => {
      const rows = await this.rows(
        this.db,
        {
          'issuedOn <=': today,
          'expiresOn >=': today,
          'expiresOn <=': addDays(today, days),
        },
        'expiresOn ASC',
      );
      // A row that was renewed is left out, so each remaining row is the
      // latest of its chain and its own history is its chain's standing.
      const superseded = await this.supersededIds(this.db, rows);
      const changes = await this.changesByHeld(this.db, rows);
      const employed = options?.employedOnly
        ? new Set(
            (await employmentsOn(this.db, this.actor.tenantId, today)).map(
              (employment) => employment.profileId,
            ),
          )
        : null;
      return rows.filter(
        (row) =>
          !superseded.has(row.id as string) &&
          statusOn(row, changes.get(row.id as string) ?? [], today) ===
            'valid' &&
          (!employed || employed.has(row.profileId)),
      );
    });
  }

  /**
   * Everything a person holds (renewed rows are replaced by their renewal),
   * each with its definition and its status computed for `on`. The status
   * agrees with {@link check}: it is `valid` when the row, or a row it renews,
   * is good on `on`, and otherwise the status of the latest row of the chain
   * issued by `on`. Ordered by qualification key, then issue date.
   *
   * @throws HrError `HR_INVALID` for a blank profile id or a bad date
   */
  async listForProfile(
    profileId: string,
    on: IsoDate,
  ): Promise<ProfileQualification[]> {
    assertIsoDate('on', on);
    const id = this.id('profileId', profileId);
    return this.scope(async () => {
      const rows = await this.rows(this.db, { profileId: id });
      const superseded = await this.supersededIds(this.db, rows);
      const statuses = chainStatusesOn(
        rows,
        await this.changesByHeld(this.db, rows),
        on,
      );
      const byRowId = new Map(rows.map((row) => [row.id as string, row]));
      // The latest row speaks for its chain: when it is not good on the date
      // but a row it renews is, the person still holds the qualification.
      // Otherwise the latest row already issued answers, as in check(): a
      // renewal recorded ahead of time does not hide a suspended or revoked
      // ticket behind `not-yet-issued`.
      const chainStatus = (
        held: HeldQualification,
      ): HeldQualificationStatusOn => {
        let answer: HeldQualificationStatusOn = 'not-yet-issued';
        const seen = new Set<string>();
        let earlier: HeldQualification | undefined = held;
        while (earlier && !seen.has(earlier.id as string)) {
          seen.add(earlier.id as string);
          const status = statuses.get(
            earlier.id as string,
          ) as HeldQualificationStatusOn;
          if (status === 'valid') return 'valid';
          if (answer === 'not-yet-issued') answer = status;
          earlier = earlier.renewalOfId
            ? byRowId.get(earlier.renewalOfId)
            : undefined;
        }
        return answer;
      };
      const definitions = await QualificationCollection.create({ db: this.db });
      const byId = new Map(
        (
          await definitions.list({ where: { tenantId: this.actor.tenantId } })
        ).map((definition) => [definition.id as string, definition]),
      );
      return rows
        .filter((row) => !superseded.has(row.id as string))
        .map((held) => ({
          held,
          qualification: byId.get(held.qualificationId) as Qualification,
          status: chainStatus(held),
        }))
        .sort(
          (a, b) =>
            a.qualification.key.localeCompare(b.qualification.key) ||
            a.held.issuedOn.localeCompare(b.held.issuedOn) ||
            createdTime(a.held) - createdTime(b.held),
        );
    });
  }

  /**
   * The dated changes of one held qualification, oldest first.
   *
   * @throws HrError `HR_NOT_FOUND` outside the actor's tenant, `HR_INVALID` for a blank id
   */
  async history(
    heldQualificationId: string,
  ): Promise<HeldQualificationChange[]> {
    const id = this.id('heldQualificationId', heldQualificationId);
    return this.scope(async () => {
      const row = await this.held(this.db, id);
      const changes = await this.changesByHeld(this.db, [row]);
      return changes.get(id) ?? [];
    });
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async byKey(
    db: DatabaseInterface,
    key: string,
  ): Promise<Qualification | null> {
    const collection = await QualificationCollection.create({ db });
    const [row] = await collection.list({
      where: { tenantId: this.actor.tenantId, key },
      limit: 1,
    });
    return row ?? null;
  }

  private async definition(
    db: DatabaseInterface,
    id: string,
  ): Promise<Qualification> {
    const collection = await QualificationCollection.create({ db });
    const [row] = await collection.list({
      where: { tenantId: this.actor.tenantId, id },
      limit: 1,
    });
    if (!row) throw new HrError('HR_NOT_FOUND', 'Qualification not found.');
    return row;
  }

  private async grantable(
    db: DatabaseInterface,
    id: string,
  ): Promise<Qualification> {
    const definition = await this.definition(db, id);
    if (!definition.isActive)
      throw invalid(`'${definition.key}' is inactive and cannot be granted.`);
    return definition;
  }

  private insertDefinition(
    db: DatabaseInterface,
    definition: Definition,
  ): Promise<Qualification> {
    return insertHr(Qualification, db, {
      tenantId: this.actor.tenantId,
      ...definition,
    });
  }

  private async held(
    db: DatabaseInterface,
    id: string,
  ): Promise<HeldQualification> {
    const [row] = await this.scope(() => this.rows(db, { id }));
    if (!row)
      throw new HrError('HR_NOT_FOUND', 'Held qualification not found.');
    return row;
  }

  /** Held rows in the actor's tenant matching `where`. */
  private async rows(
    db: DatabaseInterface,
    where: Record<string, unknown>,
    orderBy?: string,
  ): Promise<HeldQualification[]> {
    const collection = await HeldQualificationCollection.create({ db });
    return collection.list({
      where: { tenantId: this.actor.tenantId, ...where },
      orderBy,
    });
  }

  private async rowsById(
    db: DatabaseInterface,
    ids: readonly string[],
  ): Promise<HeldQualification[]> {
    const rows: HeldQualification[] = [];
    for (let at = 0; at < ids.length; at += IN_CHUNK)
      rows.push(...(await this.rows(db, { id: ids.slice(at, at + IN_CHUNK) })));
    return rows;
  }

  /**
   * The chains among `rows` (everything one person holds of one
   * qualification) that are not revoked effective on or before `on`, each
   * represented by its latest row and the date its revocation takes effect,
   * if one is recorded. The chain whose latest row is `exceptId` is skipped.
   * Decided from the dated history: a revocation stored now but effective
   * later still counts as held.
   */
  private async liveChains(
    db: DatabaseInterface,
    rows: readonly HeldQualification[],
    on: IsoDate,
    exceptId: string | null,
  ): Promise<{ row: HeldQualification; revokedOn: IsoDate | null }[]> {
    const renewed = new Set(rows.map((row) => row.renewalOfId));
    const latest = rows.filter(
      (row) => !renewed.has(row.id as string) && row.id !== exceptId,
    );
    const changes = await this.changesByHeld(db, latest);
    return latest
      .map((row) => ({
        row,
        revokedOn: revokedFrom(changes.get(row.id as string) ?? []),
      }))
      .filter(({ revokedOn }) => revokedOn === null || revokedOn > on);
  }

  /** Ids, among `rows`, that a later row renews. */
  private async supersededIds(
    db: DatabaseInterface,
    rows: readonly HeldQualification[],
  ): Promise<Set<string>> {
    const ids = rows.map((row) => row.id as string);
    const superseded = new Set<string>();
    for (let at = 0; at < ids.length; at += IN_CHUNK)
      for (const renewal of await this.rows(db, {
        renewalOfId: ids.slice(at, at + IN_CHUNK),
      }))
        if (renewal.renewalOfId) superseded.add(renewal.renewalOfId);
    return superseded;
  }

  /** Change rows per held qualification, oldest first. */
  private async changesByHeld(
    db: DatabaseInterface,
    rows: readonly HeldQualification[],
  ): Promise<Map<string, HeldQualificationChange[]>> {
    const ids = rows.map((row) => row.id as string);
    const collection = await HeldQualificationChangeCollection.create({ db });
    const all: HeldQualificationChange[] = [];
    for (let at = 0; at < ids.length; at += IN_CHUNK)
      all.push(
        ...(await collection.list({
          where: {
            tenantId: this.actor.tenantId,
            heldQualificationId: ids.slice(at, at + IN_CHUNK),
          },
        })),
      );
    all.sort(
      (a, b) =>
        a.effectiveOn.localeCompare(b.effectiveOn) ||
        createdTime(a) - createdTime(b),
    );
    const grouped = new Map<string, HeldQualificationChange[]>();
    for (const change of all)
      grouped.set(change.heldQualificationId, [
        ...(grouped.get(change.heldQualificationId) ?? []),
        change,
      ]);
    return grouped;
  }

  /**
   * The employment an employment-scoped grant belongs to (null for a
   * person-scoped one) and, when the term covering `issuedOn` already has its
   * end recorded, that term's last day. The person must be employed on
   * `issuedOn`.
   */
  private async employmentFor(
    db: DatabaseInterface,
    definition: Qualification,
    profileId: string,
    given: string | null,
    issuedOn: IsoDate,
  ): Promise<{ employmentId: string | null; endsOn: IsoDate | null }> {
    const mismatch = (message: string) =>
      new HrError('HR_QUALIFICATION_SCOPE', message);
    if (definition.scope !== 'employment') {
      if (given != null)
        throw mismatch(
          `'${definition.key}' belongs to the person; omit employmentId.`,
        );
      return { employmentId: null, endsOn: null };
    }
    const employments = await EmploymentCollection.create({ db });
    const [employment] = await employments.list({
      where: {
        tenantId: this.actor.tenantId,
        profileId,
        ...(given != null ? { id: given } : {}),
      },
      limit: 1,
    });
    if (!employment)
      throw mismatch(
        `'${definition.key}' belongs to an employment, and this person has no matching employment.`,
      );
    const terms = await EmploymentTermCollection.create({ db });
    const term = (
      await terms.list({
        where: {
          tenantId: this.actor.tenantId,
          employmentId: employment.id as string,
          'startedOn <=': issuedOn,
        },
      })
    ).find((covering) =>
      dateWithin(issuedOn, covering.startedOn, covering.endedOn),
    );
    if (!term)
      throw mismatch(
        `'${definition.key}' belongs to an employment, and this person is not employed on ${issuedOn}.`,
      );
    return { employmentId: employment.id as string, endsOn: term.endedOn };
  }

  /**
   * Insert a granted or renewed row with its change and event. With a
   * `revocation` (the end of an employment term that is already closed, or a
   * pending revocation a renewal carries forward) the row starts out cut off,
   * exactly as `EmploymentService.end()` leaves the rows that existed when
   * the end was recorded: stored `revoked`, a revocation on that date, and
   * the revoked event.
   */
  private async insertHeld(
    db: DatabaseInterface,
    queue: HrEventQueue,
    kind: 'granted' | 'renewed',
    values: {
      qualificationId: string;
      profileId: string;
      employmentId: string | null;
      revocation: Revocation | null;
      issuedOn: IsoDate;
      expiresOn: IsoDate | null;
      renewalOfId: string | null;
      input: Pick<
        GrantQualificationInput,
        'certificateNumber' | 'documentAssetId' | 'verified'
      >;
    },
  ): Promise<HeldQualification> {
    const { input, revocation, ...identityFields } = values;
    const verified = flag('verified', input.verified, false);
    const row = await insertHr(HeldQualification, db, {
      tenantId: this.actor.tenantId,
      ...identityFields,
      certificateNumber: text('certificateNumber', input.certificateNumber),
      documentAssetId: this.optionalId(
        'documentAssetId',
        input.documentAssetId,
      ),
      status: revocation === null ? 'valid' : 'revoked',
      verifiedByProfileId: verified ? this.actor.profileId : null,
      verifiedAt: verified ? new Date() : null,
    });
    await this.recordChange(db, row, kind, values.issuedOn, '');
    this.announce(queue, `held-qualification.${kind}`, row, values.issuedOn);
    if (revocation !== null) {
      await this.recordChange(
        db,
        row,
        'revoked',
        revocation.on,
        revocation.reason,
      );
      this.announce(queue, 'held-qualification.revoked', row, revocation.on);
    }
    return row;
  }

  /**
   * Suspend, reinstate or revoke the latest row of a chain. The change is
   * validated against the chain's dated history as of `effectiveOn`; the
   * stored status is not consulted, except that a row stored `revoked` is
   * never saved again and gets the change row only.
   */
  private async transition(
    heldQualificationId: string,
    kind: 'suspended' | 'reinstated' | 'revoked',
    input: { effectiveOn: IsoDate; reason: string },
  ): Promise<HeldQualification> {
    const id = this.id('heldQualificationId', heldQualificationId);
    const effectiveOn = assertIsoDate('effectiveOn', input.effectiveOn);
    await this.transact(async (db, queue) => {
      const row = await this.held(db, id);
      const siblings = await this.rows(db, {
        profileId: row.profileId,
        qualificationId: row.qualificationId,
      });
      if (siblings.some((other) => other.renewalOfId === id))
        throw invalid(
          `This qualification was renewed and cannot be ${kind} by itself; act on the latest row in its renewal chain.`,
        );
      // The change is the chain's: it may take effect while an earlier row is
      // the one in force, before this row's own issue date.
      const byId = new Map(
        siblings.map((other) => [other.id as string, other]),
      );
      const chain: HeldQualification[] = [];
      for (
        let member: HeldQualification | undefined = row;
        member && !chain.includes(member);
        member = member.renewalOfId ? byId.get(member.renewalOfId) : undefined
      )
        chain.push(member);
      const firstIssuedOn = chain.reduce(
        (first, member) => (member.issuedOn < first ? member.issuedOn : first),
        row.issuedOn,
      );
      if (effectiveOn < firstIssuedOn)
        throw invalid(
          `effectiveOn must not be before the qualification was issued on ${firstIssuedOn}.`,
        );
      const changes = await this.changesByHeld(db, chain);
      const history = chain.flatMap(
        (member) => changes.get(member.id as string) ?? [],
      );
      if (kind === 'revoked') {
        // Terminal, and the earliest one wins in replay, so it needs no
        // ordering against other changes: only an earlier or same-day
        // revocation makes it pointless.
        const revokedOn = revokedFrom(history);
        if (revokedOn !== null && revokedOn <= effectiveOn)
          throw new HrError(
            'HR_STATUS_TRANSITION',
            `This qualification is already revoked from ${revokedOn}.`,
          );
      } else {
        // Suspensions and reinstatements are recorded in date order, so the
        // replay never has to reorder them.
        const changedOn = latestOf(history, SUSPENSION_KINDS);
        if (changedOn !== null && effectiveOn < changedOn)
          throw invalid(
            `effectiveOn must not be before the latest suspension or reinstatement on ${changedOn}.`,
          );
        const standing = standingOn(history, effectiveOn) ?? 'valid';
        if (standing !== (kind === 'suspended' ? 'valid' : 'suspended'))
          throw new HrError(
            'HR_STATUS_TRANSITION',
            standing === 'valid'
              ? `A qualification that is not suspended on ${effectiveOn} cannot be reinstated.`
              : `A qualification that is ${standing} on ${effectiveOn} cannot be ${kind}.`,
          );
      }
      // `revoked` is final in storage: a row that already stores it is never
      // saved again, and the dated change alone carries the new fact.
      if (row.status !== 'revoked') {
        const lapsed = (changes.get(id) ?? []).some(
          (change) => change.kind === 'expired',
        );
        row.status =
          kind === 'reinstated' ? (lapsed ? 'expired' : 'valid') : kind;
        await persistHr(row);
      }
      await this.recordChange(db, row, kind, effectiveOn, input.reason);
      this.announce(queue, `held-qualification.${kind}`, row, effectiveOn);
    });
    return this.held(this.db, id);
  }

  private async recordChange(
    db: DatabaseInterface,
    row: HeldQualification,
    kind: HeldQualificationChangeKind,
    effectiveOn: IsoDate,
    reason: string,
  ): Promise<void> {
    await insertHr(HeldQualificationChange, db, {
      tenantId: this.actor.tenantId,
      heldQualificationId: row.id as string,
      kind,
      effectiveOn,
      reason,
      actorProfileId: this.actor.profileId,
    });
  }

  private announce(
    queue: HrEventQueue,
    type: HeldQualificationEventType,
    heldQualification: HeldQualification,
    effectiveOn: IsoDate,
  ): void {
    queue({
      type,
      heldQualification,
      effectiveOn,
      at: new Date(),
      byProfileId: this.actor.profileId,
    });
  }
}
