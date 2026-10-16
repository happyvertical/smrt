import { getTenantId, withTenant } from '@happyvertical/smrt-tenancy';
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
export interface EligibilityRow {
  memberId: string;
  displayName: string;
  memberClassKey: string;
  recordDate: IsoDate;
  eligible: boolean;
  reason: string;
  evidence: Record<string, unknown>;
}

/** Trusted, tenant-scoped register writer. Hosts authorize the actor before construction. */
export class MemberRegisterService {
  constructor(
    private readonly db: DatabaseInterface,
    private readonly actor: MemberRegisterActor,
  ) {
    text(actor?.tenantId, 'tenantId');
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
      const row = await histories.create({
        tenantId: this.actor.tenantId,
        memberId: member.id as string,
        status: input.status,
        effectiveOn,
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
        .sort((a, b) => a.effectiveOn.localeCompare(b.effectiveOn))
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
  async asOf(
    recordDate: IsoDate,
    policy: EligibilityPolicy = {},
  ): Promise<EligibilityRow[]> {
    return this.scope(async () => {
      const on = date(recordDate, 'recordDate');
      const members = await LegalMemberCollection.create({ db: this.db });
      const classes = await MemberClassCollection.create({ db: this.db });
      const histories = await LegalMemberStatusHistoryCollection.create({
        db: this.db,
      });
      const refs = await LegalMemberReferenceCollection.create({ db: this.db });
      const snapshots = await MemberEligibilitySnapshotCollection.create({
        db: this.db,
      });
      const rows: EligibilityRow[] = [];
      for (const member of await members.list({
        where: { tenantId: this.actor.tenantId },
      })) {
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
          .sort(
            (a, b) =>
              a.effectiveOn.localeCompare(b.effectiveOn) ||
              String(a.created_at ?? '').localeCompare(
                String(b.created_at ?? ''),
              ),
          );
        const status = history.at(-1)?.status;
        const memberRefs = (
          await refs.list({
            where: { tenantId: this.actor.tenantId, memberId: member.id },
          })
        ).filter(
          (reference) =>
            reference.effectiveFrom <= on &&
            (reference.effectiveTo === null || reference.effectiveTo >= on),
        );
        const missing = (policy.requireAuthoritativeKinds ?? []).filter(
          (kind) =>
            !memberRefs.some(
              (reference) => reference.kind === kind && reference.authoritative,
            ),
        );
        const classOK =
          !policy.memberClassKeys?.length ||
          (!!klass && policy.memberClassKeys.includes(klass.key));
        const statusOK =
          !!status && (policy.statuses ?? ['active']).includes(status);
        const eligible =
          member.joinedOn <= on &&
          (member.leftOn === null || member.leftOn >= on) &&
          classOK &&
          statusOK &&
          missing.length === 0;
        const reason = missing.length
          ? `authoritative evidence unavailable: ${missing.join(', ')}`
          : !classOK
            ? 'member class excluded by policy'
            : !statusOK
              ? `status ${status ?? 'unrecorded'} excluded by policy`
              : member.joinedOn > on
                ? 'joined after record date'
                : member.leftOn && member.leftOn < on
                  ? 'left before record date'
                  : 'eligible';
        const evidence = {
          status,
          requiredAuthoritativeKinds: policy.requireAuthoritativeKinds ?? [],
          missingAuthoritativeKinds: missing,
          referenceCount: memberRefs.length,
        };
        const row: EligibilityRow = {
          memberId: member.id as string,
          displayName: member.displayName,
          memberClassKey: klass?.key ?? '',
          recordDate: on,
          eligible,
          reason,
          evidence,
        };
        const snapshot = await snapshots.create({
          tenantId: this.actor.tenantId,
          memberId: row.memberId,
          recordDate: on,
          eligible,
          reason,
          evidence,
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
