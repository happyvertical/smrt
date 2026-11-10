import { ProfileCollection } from '@happyvertical/smrt-profiles';
import {
  getTenantId,
  withTenant,
  withTenantGlobalRead,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  type LegalMember,
  LegalMemberCollection,
  type LegalMemberKind,
  type LegalMemberReference,
  LegalMemberReferenceCollection,
  type LegalMemberStatus,
  LegalMemberStatusHistoryCollection,
  type MemberClass,
  MemberClassCollection,
  type MemberEligibilitySnapshot,
  MemberEligibilitySnapshotCollection,
  type MemberOfficerAppointment,
  MemberOfficerAppointmentCollection,
  type MemberReferenceKind,
} from './models.js';

export type IsoDate = string;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MEMBER_STATUSES: readonly LegalMemberStatus[] = [
  'active',
  'suspended',
  'resigned',
  'ceased',
];
const REFERENCE_KINDS: readonly MemberReferenceKind[] = [
  'share',
  'dues',
  'subscription',
  'agreement',
  'ledger',
];
function compareHistory(
  a: { effectiveOn: string; sequence: number },
  b: { effectiveOn: string; sequence: number },
): number {
  return a.effectiveOn.localeCompare(b.effectiveOn) || a.sequence - b.sequence;
}
function date(value: unknown, field: string): IsoDate {
  if (
    typeof value !== 'string' ||
    !ISO_DATE.test(value) ||
    Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  )
    throw new MemberRegisterError(
      'MEMBER_REGISTER_INVALID',
      `${field} must be YYYY-MM-DD.`,
    );
  if (new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value)
    throw new MemberRegisterError(
      'MEMBER_REGISTER_INVALID',
      `${field} must be a calendar date.`,
    );
  return value;
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim())
    throw new MemberRegisterError(
      'MEMBER_REGISTER_INVALID',
      `${field} is required.`,
    );
  return value.trim();
}
export class MemberRegisterError extends Error {
  constructor(
    readonly code:
      | 'MEMBER_REGISTER_INVALID'
      | 'MEMBER_REGISTER_NOT_FOUND'
      | 'MEMBER_REGISTER_TENANT_MISMATCH',
    message: string,
  ) {
    super(message);
    this.name = 'MemberRegisterError';
  }
}
export interface MemberRegisterActor {
  tenantId: string;
  actorRef?: string;
}
export interface EligibilityPolicy {
  memberClassKeys?: readonly string[];
  statuses?: readonly LegalMemberStatus[];
  requireAuthoritativeKinds?: readonly MemberReferenceKind[];
}
/** Exactly one explicit legal member or login identity within the actor tenant. */
export type MemberEligibilityIdentity =
  | { memberId: string; userId?: never }
  | { userId: string; memberId?: never };

export interface EligibilityRow {
  memberId: string;
  displayName: string;
  memberClassKey: string;
  recordDate: IsoDate;
  eligible: boolean;
  reason: string;
  evidence: Record<string, unknown>;
}

function normalizeEligibilityPolicy(
  policy: EligibilityPolicy,
): EligibilityPolicy {
  if (
    !policy ||
    typeof policy !== 'object' ||
    [
      policy.memberClassKeys,
      policy.statuses,
      policy.requireAuthoritativeKinds,
    ].some((values) => values !== undefined && !Array.isArray(values))
  )
    throw new MemberRegisterError(
      'MEMBER_REGISTER_INVALID',
      'Eligibility policy values must be arrays.',
    );
  // Copy caller arrays before the first asynchronous read.
  const memberClassKeys =
    policy.memberClassKeys === undefined ? null : [...policy.memberClassKeys];
  const statuses = [...(policy.statuses ?? ['active'])];
  const requiredAuthoritativeKinds = [
    ...(policy.requireAuthoritativeKinds ?? []),
  ];
  if (
    memberClassKeys?.some((key) => typeof key !== 'string' || !key.trim()) ||
    statuses.some((status) => !MEMBER_STATUSES.includes(status)) ||
    requiredAuthoritativeKinds.some((kind) => !REFERENCE_KINDS.includes(kind))
  )
    throw new MemberRegisterError(
      'MEMBER_REGISTER_INVALID',
      'Unknown or malformed eligibility policy.',
    );
  return {
    ...(memberClassKeys === null ? {} : { memberClassKeys }),
    statuses,
    requireAuthoritativeKinds: requiredAuthoritativeKinds,
  };
}

/** Trusted, tenant-scoped register writer. Hosts authorize the actor before construction. */
export class MemberRegisterService {
  private static readonly transactionToken = Symbol(
    'member-register-transaction',
  );
  constructor(
    private readonly db: DatabaseInterface,
    private readonly actor: MemberRegisterActor,
    private readonly transactionBound?: symbol,
  ) {
    text(actor?.tenantId, 'tenantId');
  }
  /** Atomically accept a host command and its evidence on the same executor.
   * The callback service and executor must not escape the callback.
   */
  withTransaction<T>(
    operation: (
      service: MemberRegisterService,
      db: DatabaseInterface,
    ) => Promise<T>,
  ): Promise<T> {
    if (this.transactionBound === MemberRegisterService.transactionToken)
      return this.scope(() => operation(this, this.db));
    if (!this.db.transaction)
      throw new MemberRegisterError(
        'MEMBER_REGISTER_INVALID',
        'Member register writes require transaction support.',
      );
    const transaction = this.db.transaction.bind(this.db);
    return this.scope(() =>
      transaction((db) =>
        operation(
          new MemberRegisterService(
            db,
            this.actor,
            MemberRegisterService.transactionToken,
          ),
          db,
        ),
      ),
    );
  }
  private scope<T>(run: () => Promise<T>): Promise<T> {
    const active = getTenantId();
    if (active && active !== this.actor.tenantId)
      throw new MemberRegisterError(
        'MEMBER_REGISTER_TENANT_MISMATCH',
        'Actor differs from active tenant.',
      );
    return withTenant({ tenantId: this.actor.tenantId }, run);
  }
  private async member(memberId: string): Promise<LegalMember> {
    const members = await LegalMemberCollection.create({ db: this.db });
    const member = await members.get({
      id: text(memberId, 'memberId'),
      tenantId: this.actor.tenantId,
    });
    if (!member)
      throw new MemberRegisterError(
        'MEMBER_REGISTER_NOT_FOUND',
        'Member not found in this tenant.',
      );
    return member;
  }
  private assertReferenceKind(kind: MemberReferenceKind): void {
    if (!REFERENCE_KINDS.includes(kind))
      throw new MemberRegisterError(
        'MEMBER_REGISTER_INVALID',
        'Unknown member reference kind.',
      );
  }
  async addClass(input: {
    key: string;
    name: string;
    description?: string;
    policyMetadata?: Record<string, unknown> | null;
  }): Promise<MemberClass> {
    return this.scope(async () => {
      const classes = await MemberClassCollection.create({ db: this.db });
      const value = await classes.create({
        tenantId: this.actor.tenantId,
        key: text(input.key, 'key'),
        name: text(input.name, 'name'),
        description: input.description?.trim() ?? '',
        policyMetadata: input.policyMetadata ?? null,
      });
      return value;
    });
  }
  async enroll(input: {
    memberClassId: string;
    kind: LegalMemberKind;
    displayName: string;
    joinedOn: IsoDate;
    userId?: string | null;
    profileId?: string | null;
    externalPartyRef?: string | null;
  }): Promise<LegalMember> {
    if (this.transactionBound !== MemberRegisterService.transactionToken) {
      const member = await this.withTransaction((service) =>
        service.enroll(input),
      );
      return this.scope(() => this.member(member.id as string));
    }
    return this.scope(async () => {
      const joinedOn = date(input.joinedOn, 'joinedOn');
      if (input.kind !== 'individual' && input.kind !== 'organisation')
        throw new MemberRegisterError(
          'MEMBER_REGISTER_INVALID',
          'kind must be individual or organisation.',
        );
      const classes = await MemberClassCollection.create({ db: this.db });
      const klass = await classes.get({
        id: text(input.memberClassId, 'memberClassId'),
        tenantId: this.actor.tenantId,
      });
      if (!klass)
        throw new MemberRegisterError(
          'MEMBER_REGISTER_NOT_FOUND',
          'Member class not found in this tenant.',
        );
      if (input.profileId != null) {
        const profiles = await ProfileCollection.create({ db: this.db });
        const matches = await withTenantGlobalRead(this.actor.tenantId, () =>
          profiles.list({
            where: { id: text(input.profileId, 'profileId') },
            limit: 1,
          }),
        );
        const profile = matches[0];
        if (
          !profile ||
          (profile.tenantId !== null &&
            profile.tenantId !== this.actor.tenantId)
        )
          throw new MemberRegisterError(
            'MEMBER_REGISTER_NOT_FOUND',
            'Profile not found in this tenant or global scope.',
          );
      }
      const members = await LegalMemberCollection.create({ db: this.db });
      const member = await members.create({
        tenantId: this.actor.tenantId,
        memberClassId: klass.id as string,
        kind: input.kind,
        displayName: text(input.displayName, 'displayName'),
        joinedOn,
        userId: input.userId ?? null,
        profileId: input.profileId ?? null,
        externalPartyRef: input.externalPartyRef?.trim() || null,
        status: 'active',
      });
      const history = await LegalMemberStatusHistoryCollection.create({
        db: this.db,
      });
      const joined = await history.create({
        tenantId: this.actor.tenantId,
        memberId: member.id as string,
        status: 'active',
        effectiveOn: joinedOn,
        sequence: 1,
        reason: 'joined',
        actorRef: this.actor.actorRef ?? null,
      });
      return member;
    });
  }
  async setStatus(
    memberId: string,
    input: { status: LegalMemberStatus; effectiveOn: IsoDate; reason?: string },
  ): Promise<LegalMember> {
    if (this.transactionBound !== MemberRegisterService.transactionToken) {
      const member = await this.withTransaction((service) =>
        service.setStatus(memberId, input),
      );
      return this.scope(() => this.member(member.id as string));
    }
    return this.scope(async () => {
      const member = await this.member(memberId);
      const effectiveOn = date(input.effectiveOn, 'effectiveOn');
      if (!MEMBER_STATUSES.includes(input.status))
        throw new MemberRegisterError(
          'MEMBER_REGISTER_INVALID',
          'Unknown member status.',
        );
      const histories = await LegalMemberStatusHistoryCollection.create({
        db: this.db,
      });
      const prior = await histories.list({
        where: { tenantId: this.actor.tenantId, memberId: member.id },
      });
      const row = await histories.create({
        tenantId: this.actor.tenantId,
        memberId: member.id as string,
        status: input.status,
        effectiveOn,
        sequence: Math.max(0, ...prior.map((entry) => entry.sequence ?? 0)) + 1,
        reason: input.reason?.trim() ?? '',
        actorRef: this.actor.actorRef ?? null,
      });
      const today = new Date().toISOString().slice(0, 10);
      const current = (
        await histories.list({
          where: { tenantId: this.actor.tenantId, memberId: member.id },
        })
      )
        .filter((entry) => entry.effectiveOn <= today)
        .sort(compareHistory)
        .at(-1);
      member.status = current?.status ?? 'active';
      member.leftOn =
        current?.status === 'resigned' || current?.status === 'ceased'
          ? current.effectiveOn
          : null;
      await member.save();
      return member;
    });
  }
  async addReference(
    memberId: string,
    input: {
      kind: MemberReferenceKind;
      sourceType: string;
      sourceId: string;
      authoritative?: boolean;
      effectiveFrom: IsoDate;
      effectiveTo?: IsoDate | null;
    },
  ): Promise<LegalMemberReference> {
    return this.scope(async () => {
      const member = await this.member(memberId);
      this.assertReferenceKind(input.kind);
      const effectiveFrom = date(input.effectiveFrom, 'effectiveFrom');
      const effectiveTo =
        input.effectiveTo == null
          ? null
          : date(input.effectiveTo, 'effectiveTo');
      if (effectiveTo && effectiveTo < effectiveFrom)
        throw new MemberRegisterError(
          'MEMBER_REGISTER_INVALID',
          'effectiveTo must not precede effectiveFrom.',
        );
      const refs = await LegalMemberReferenceCollection.create({ db: this.db });
      const row = await refs.create({
        tenantId: this.actor.tenantId,
        memberId: member.id as string,
        kind: input.kind,
        sourceType: text(input.sourceType, 'sourceType'),
        sourceId: text(input.sourceId, 'sourceId'),
        authoritative: input.authoritative === true,
        effectiveFrom,
        effectiveTo,
      });
      return row;
    });
  }
  /** Append a dated withdrawal without changing past evidence or snapshots. */
  async revokeReference(
    referenceId: string,
    input: { effectiveOn: IsoDate },
  ): Promise<LegalMemberReference> {
    return this.scope(async () => {
      const refs = await LegalMemberReferenceCollection.create({ db: this.db });
      const reference = await refs.get({
        id: text(referenceId, 'referenceId'),
        tenantId: this.actor.tenantId,
      });
      if (!reference)
        throw new MemberRegisterError(
          'MEMBER_REGISTER_NOT_FOUND',
          'Reference not found in this tenant.',
        );
      const effectiveFrom = date(input.effectiveOn, 'effectiveOn');
      if (reference.revokesId || effectiveFrom < reference.effectiveFrom)
        throw new MemberRegisterError(
          'MEMBER_REGISTER_INVALID',
          'Revoke original evidence on or after its effectiveFrom date.',
        );
      return refs.create({
        tenantId: this.actor.tenantId,
        memberId: reference.memberId,
        kind: reference.kind,
        sourceType: reference.sourceType,
        sourceId: reference.sourceId,
        authoritative: false,
        effectiveFrom,
        revokesId: reference.id as string,
      });
    });
  }
  async appoint(
    memberId: string,
    input: {
      role: string;
      effectiveFrom: IsoDate;
      effectiveTo?: IsoDate | null;
      authority?: Record<string, unknown> | null;
    },
  ): Promise<MemberOfficerAppointment> {
    return this.scope(async () => {
      const member = await this.member(memberId);
      const from = date(input.effectiveFrom, 'effectiveFrom');
      const to =
        input.effectiveTo == null
          ? null
          : date(input.effectiveTo, 'effectiveTo');
      if (to && to < from)
        throw new MemberRegisterError(
          'MEMBER_REGISTER_INVALID',
          'effectiveTo must not precede effectiveFrom.',
        );
      const appointments = await MemberOfficerAppointmentCollection.create({
        db: this.db,
      });
      const row = await appointments.create({
        tenantId: this.actor.tenantId,
        memberId: member.id as string,
        role: text(input.role, 'role'),
        effectiveFrom: from,
        effectiveTo: to,
        authority: input.authority ?? null,
      });
      return row;
    });
  }
  /** Read one member without snapshots, register enumeration or a transaction. */
  async eligibilityFor(
    identity: MemberEligibilityIdentity,
    recordDate: IsoDate,
    policy: EligibilityPolicy = {},
  ): Promise<EligibilityRow> {
    return this.scope(async () => {
      const capturedPolicy = normalizeEligibilityPolicy(policy);
      if (
        !identity ||
        (identity.memberId !== undefined) === (identity.userId !== undefined)
      )
        throw new MemberRegisterError(
          'MEMBER_REGISTER_INVALID',
          'Supply exactly one memberId or userId.',
        );
      const members = await LegalMemberCollection.create({ db: this.db });
      let member: LegalMember;
      if (identity.memberId !== undefined)
        member = await this.member(identity.memberId);
      else {
        const matches = await members.list({
          where: {
            tenantId: this.actor.tenantId,
            userId: text(identity.userId, 'userId'),
          },
          limit: 2,
        });
        if (matches.length !== 1)
          throw new MemberRegisterError(
            'MEMBER_REGISTER_NOT_FOUND',
            'Member identity not uniquely found in this tenant.',
          );
        member = matches[0];
      }
      return this.evaluateMember(member, recordDate, capturedPolicy);
    });
  }

  /** Explicit immutable evidence write; call inside withTransaction for accepted commands. */
  async captureEligibility(
    identity: MemberEligibilityIdentity,
    recordDate: IsoDate,
    policy: EligibilityPolicy = {},
  ): Promise<MemberEligibilitySnapshot> {
    return this.withTransaction(async (service) => {
      const row = await service.eligibilityFor(identity, recordDate, policy);
      const snapshots = await MemberEligibilitySnapshotCollection.create({
        db: service.db,
      });
      return service.scope(() =>
        snapshots.create({
          tenantId: service.actor.tenantId,
          memberId: row.memberId,
          recordDate: row.recordDate,
          eligible: row.eligible,
          reason: row.reason,
          evidence: row.evidence,
        }),
      );
    });
  }

  private async evaluateMember(
    member: LegalMember,
    recordDate: IsoDate,
    policy: EligibilityPolicy,
  ): Promise<EligibilityRow> {
    const on = date(recordDate, 'recordDate');
    const memberClassKeys = policy.memberClassKeys ?? null;
    const statuses = policy.statuses ?? ['active'];
    const requiredAuthoritativeKinds = policy.requireAuthoritativeKinds ?? [];
    const classes = await MemberClassCollection.create({ db: this.db });
    const histories = await LegalMemberStatusHistoryCollection.create({
      db: this.db,
    });
    const refs = await LegalMemberReferenceCollection.create({ db: this.db });
    const klass = await classes.get({
      id: member.memberClassId,
      tenantId: this.actor.tenantId,
    });
    const history = (
      await histories.list({
        where: { tenantId: this.actor.tenantId, memberId: member.id },
      })
    )
      .filter((entry) => entry.effectiveOn <= on)
      .sort(compareHistory);
    const status = history.at(-1)?.status;
    const allRefs = await refs.list({
      where: { tenantId: this.actor.tenantId, memberId: member.id },
    });
    const revoked = new Set(
      allRefs
        .filter(
          (reference) => reference.revokesId && reference.effectiveFrom <= on,
        )
        .map((reference) => reference.revokesId),
    );
    const memberRefs = allRefs.filter(
      (reference) =>
        !reference.revokesId &&
        !revoked.has(reference.id as string) &&
        reference.effectiveFrom <= on &&
        (reference.effectiveTo === null || reference.effectiveTo >= on),
    );
    const missing = requiredAuthoritativeKinds.filter(
      (kind) =>
        !memberRefs.some(
          (reference) => reference.kind === kind && reference.authoritative,
        ),
    );
    const classOK =
      memberClassKeys === null ||
      (!!klass && memberClassKeys.includes(klass.key));
    const statusOK = !!status && statuses.includes(status);
    const eligible =
      member.joinedOn <= on && classOK && statusOK && missing.length === 0;
    const reason = missing.length
      ? `authoritative evidence unavailable: ${missing.join(', ')}`
      : !classOK
        ? 'member class excluded by policy'
        : !statusOK
          ? `status ${status ?? 'unrecorded'} excluded by policy`
          : member.joinedOn > on
            ? 'joined after record date'
            : 'eligible';
    const evidence = {
      status,
      memberClassKeys,
      statuses,
      requiredAuthoritativeKinds,
      missingAuthoritativeKinds: missing,
      referenceCount: memberRefs.length,
    };
    return {
      memberId: member.id as string,
      displayName: member.displayName,
      memberClassKey: klass?.key ?? '',
      recordDate: on,
      eligible,
      reason,
      evidence,
    };
  }

  async asOf(
    recordDate: IsoDate,
    policy: EligibilityPolicy = {},
  ): Promise<EligibilityRow[]> {
    if (this.transactionBound !== MemberRegisterService.transactionToken)
      return this.withTransaction((service) =>
        service.asOf(recordDate, policy),
      );
    return this.scope(async () => {
      const on = date(recordDate, 'recordDate');
      const capturedPolicy = normalizeEligibilityPolicy(policy);
      const members = await LegalMemberCollection.create({ db: this.db });
      const snapshots = await MemberEligibilitySnapshotCollection.create({
        db: this.db,
      });
      const rows: EligibilityRow[] = [];
      for (const member of await members.list({
        where: { tenantId: this.actor.tenantId },
      })) {
        const row = await this.evaluateMember(member, on, capturedPolicy);
        const snapshot = await snapshots.create({
          tenantId: this.actor.tenantId,
          memberId: row.memberId,
          recordDate: on,
          eligible: row.eligible,
          reason: row.reason,
          evidence: row.evidence,
        });
        rows.push(row);
      }
      return rows;
    });
  }
  static exportJson(rows: readonly EligibilityRow[]): string {
    return JSON.stringify(rows);
  }
  static exportCsv(rows: readonly EligibilityRow[]): string {
    // CSV is commonly opened in spreadsheets. Preserve the neutral export
    // value while preventing a member-supplied cell from becoming a formula.
    const q = (value: unknown) => {
      const text = String(value ?? '');
      const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
      return `"${safe.replaceAll('"', '""')}"`;
    };
    return `${[
      'memberId,displayName,memberClassKey,recordDate,eligible,reason',
      ...rows.map((row) =>
        [
          row.memberId,
          row.displayName,
          row.memberClassKey,
          row.recordDate,
          row.eligible,
          row.reason,
        ]
          .map(q)
          .join(','),
      ),
    ].join('\n')}\n`;
  }
}
