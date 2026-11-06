import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import { getTenantId, withTenant } from '@happyvertical/smrt-tenancy';
import { AttributionExceptionCollection } from '../collections/AttributionExceptionCollection.js';
import { AttributionPolicyCollection } from '../collections/AttributionPolicyCollection.js';
import { ReferralCollection } from '../collections/ReferralCollection.js';
import {
  REFERRAL_CODE_LENGTH,
  ReferralLinkCollection,
} from '../collections/ReferralLinkCollection.js';
import { ReferralProgramCollection } from '../collections/ReferralProgramCollection.js';
import { ReferralTouchCollection } from '../collections/ReferralTouchCollection.js';
import { ReferrerCollection } from '../collections/ReferrerCollection.js';
import {
  ReferrerIdentifierCollection,
  type RegisterReferrerIdentifierInput,
} from '../collections/ReferrerIdentifierCollection.js';
import type { ReferralProgram } from '../models/ReferralProgram.js';
import type { ReferralTouch } from '../models/ReferralTouch.js';
import type { Referrer } from '../models/Referrer.js';
import type { ReferrerIdentifier } from '../models/ReferrerIdentifier.js';
import { nominationUuid, normalizeIdentifier } from '../nomination-identity.js';
import type {
  AttributionExceptionCandidate,
  ReferralNominationEvidence,
} from '../types.js';
import {
  type AttributionResolution,
  AttributionService,
} from './AttributionService.js';

const EMAIL =
  /[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
const CODE = new RegExp(`^[a-z0-9]{${REFERRAL_CODE_LENGTH}}$`, 'u');
const MIN_NAME_SCORE = 0.85;
const MIN_NAME_MARGIN = 0.12;
const MAX_NOMINATION_BYTES = 1024;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface RecordReferralNominationInput {
  tenantId: string | null;
  programId: string;
  subjectKind: string;
  subjectId: string;
  nominationText: string;
  nominationEmail?: string;
  nominationCode?: string;
  actorProfileId?: string;
  occurredAt?: Date;
  now?: Date;
}

export interface ResolveReferralNominationInput
  extends RecordReferralNominationInput {
  targetKind: string;
  targetId: string;
  subjectProfileId?: string;
  isExistingClient?: boolean;
}

interface NominationMatch {
  referrerId: string;
  matchedBy: ReferralNominationEvidence['matchedBy'];
  matchedIdentifierId?: string;
  linkId?: string;
  code?: string;
}

interface NominationTags {
  text: string;
  emails: string[];
  codes: string[];
  name: string;
}

export class ReferralNominationResolver {
  private readonly attribution: AttributionService;

  private constructor(
    private readonly touches: ReferralTouchCollection,
    private readonly referrals: ReferralCollection,
    private readonly exceptions: AttributionExceptionCollection,
    private readonly policies: AttributionPolicyCollection,
    private readonly programs: ReferralProgramCollection,
    private readonly referrers: ReferrerCollection,
    private readonly links: ReferralLinkCollection,
    private readonly identifiers: ReferrerIdentifierCollection,
  ) {
    this.attribution = new AttributionService({
      touches,
      referrals,
      exceptions,
      policies,
      programs,
      referrers,
    });
  }

  static async create(
    options: SmrtClassOptions = {},
  ): Promise<ReferralNominationResolver> {
    const touches = await ReferralTouchCollection.create(options);
    const shared = {
      ...options,
      db: touches.db,
      _reuseInitializedDb: true,
      _deferRuntimeInitialization: true,
    };
    return new ReferralNominationResolver(
      touches,
      await ReferralCollection.create(shared),
      await AttributionExceptionCollection.create(shared),
      await AttributionPolicyCollection.create(shared),
      await ReferralProgramCollection.create(shared),
      await ReferrerCollection.create(shared),
      await ReferralLinkCollection.create(shared),
      await ReferrerIdentifierCollection.create(shared),
    );
  }

  /** Record immutable evidence for a confidently matched prospect at intake. */
  async recordNomination(
    input: RecordReferralNominationInput,
  ): Promise<ReferralTouch | null> {
    return await inTenant(input.tenantId, async () => {
      const program = await this.requireProgram(input);
      if (!program.isActive()) return null;
      const tags = parseNomination(input);
      const occurredAt = input.occurredAt ?? input.now ?? new Date();
      const result = await this.recordMatch(input, tags, occurredAt);
      return result.touch;
    });
  }

  /**
   * Apply the program's policy to a prospect's nomination and existing touches.
   * Like AttributionService, use a caller transaction and serialize writes
   * per target and program when multiple workers can qualify the same target.
   */
  async resolve(
    input: ResolveReferralNominationInput,
  ): Promise<AttributionResolution> {
    // Keep background resolution in its explicit tenant lane so policy
    // lookup can apply the canonical global fallback.
    assertTenantLane(input.tenantId);
    const program = await this.requireProgram(input);
    const existing = await this.attribution.findExistingResolution(
      input,
      input.tenantId,
    );
    if (existing) return existing;
    if (!program.isActive()) {
      return {
        referrals: [],
        exception: null,
        refused: 'no_eligible_touches',
      };
    }

    const now = input.now ?? new Date();
    const policy = await this.policies.latestActiveByKey(
      program.defaultAttributionPolicyKey,
      now,
      input.tenantId,
    );
    if (!program.defaultAttributionPolicyKey || !policy) {
      return { referrals: [], exception: null, refused: 'no_active_policy' };
    }
    if (input.isExistingClient && !policy.allowExistingClients) {
      return {
        referrals: [],
        exception: null,
        refused: 'existing_client_ineligible',
      };
    }

    const tags = parseNomination(input);
    const occurredAt = input.occurredAt ?? now;
    if (
      occurredAt > now ||
      occurredAt.getTime() < now.getTime() - policy.windowDays * MS_PER_DAY
    ) {
      return await this.attribution.resolve({ ...input, now });
    }
    const { touch, candidates } = await this.recordMatch(
      input,
      tags,
      occurredAt,
    );
    if (touch) return await this.attribution.resolve({ ...input, now });

    const exception = await this.exceptions.create({
      tenantId: input.tenantId,
      programId: input.programId,
      targetKind: input.targetKind,
      targetId: input.targetId,
      status: 'open',
      conflictReason: 'nomination_unresolved',
      candidates: JSON.stringify(
        candidates.map(
          (referrerId): AttributionExceptionCandidate => ({
            touchId: '',
            referrerId,
            kind: 'nomination',
            occurredAt: occurredAt.toISOString(),
          }),
        ),
      ),
      metadata: JSON.stringify({
        ...nominationInputs(input),
        subjectKind: input.subjectKind,
        subjectId: input.subjectId,
        policyKey: policy.policyKey,
        policyVersion: policy.version,
        windowDays: policy.windowDays,
      }),
    });
    return { referrals: [], exception };
  }

  /**
   * Remember a verified alias for a referrer awarded credit through
   * AttributionService.resolveException. May join the same host transaction.
   */
  async registerResolvedIdentifier(
    input: Pick<
      RegisterReferrerIdentifierInput,
      'tenantId' | 'referrerId' | 'kind' | 'value'
    > & { exceptionId: string },
  ): Promise<ReferrerIdentifier> {
    return await inTenant(input.tenantId, async () => {
      const exception = await this.exceptions.get({ id: input.exceptionId });
      if (
        !exception ||
        exception.tenantId !== input.tenantId ||
        exception.status !== 'resolved' ||
        exception.conflictReason !== 'nomination_unresolved'
      ) {
        throw new Error(
          'A resolved nomination exception in the same tenant is required',
        );
      }
      for (const id of exception.getResolvedReferralIds()) {
        const referral = await this.referrals.get({ id });
        if (
          referral?.tenantId === input.tenantId &&
          referral.referrerId === input.referrerId &&
          referral.programId === exception.programId
        ) {
          return await this.identifiers.register({
            ...input,
            programId: exception.programId,
            metadata: {
              nominationExceptionId: exception.id,
              confirmedByProfileId: exception.resolvedByProfileId,
            },
          });
        }
      }
      throw new Error(
        'The referrer did not receive credit from this nomination exception',
      );
    });
  }

  private async requireProgram(
    input: RecordReferralNominationInput,
  ): Promise<ReferralProgram> {
    const program = await this.programs.get({ id: input.programId });
    if (!program || program.tenantId !== input.tenantId) {
      throw new Error(
        'Referral nomination requires a program in the same tenant',
      );
    }
    return program;
  }

  private async recordMatch(
    input: RecordReferralNominationInput,
    tags: NominationTags,
    occurredAt: Date,
  ): Promise<{
    touch: ReferralTouch | null;
    candidates: string[];
  }> {
    const id = nominationUuid([
      'referral-nomination',
      input.tenantId,
      input.programId,
      input.subjectKind,
      input.subjectId,
      tags.text,
      normalizeIdentifier(input.nominationEmail ?? ''),
      normalizeIdentifier(input.nominationCode ?? ''),
    ]);
    const stored = await this.touches.get({ id });
    if (stored) {
      if (
        stored.tenantId !== input.tenantId ||
        stored.programId !== input.programId ||
        stored.kind !== 'nomination' ||
        stored.subjectKind !== input.subjectKind ||
        stored.subjectId !== input.subjectId
      ) {
        throw new Error('Referral nomination touch identity is already in use');
      }
      return { touch: stored, candidates: [] };
    }

    const { match, candidates } = await this.findMatch(input, tags);
    if (!match) return { touch: null, candidates };

    const evidence: ReferralNominationEvidence = {
      ...nominationInputs(input),
      matchedBy: match.matchedBy,
      matchedIdentifierId: match.matchedIdentifierId,
    };
    const touch = await this.touches.create({
      id,
      _insertOnly: true,
      tenantId: input.tenantId,
      programId: input.programId,
      referrerId: match.referrerId,
      ...(match.linkId && { linkId: match.linkId, code: match.code }),
      kind: 'nomination',
      subjectKind: input.subjectKind,
      subjectId: input.subjectId,
      occurredAt,
      evidence: JSON.stringify(evidence),
    });
    return { touch, candidates: [] };
  }

  private async findMatch(
    input: RecordReferralNominationInput,
    tags: NominationTags,
  ): Promise<{
    match?: NominationMatch;
    candidates: string[];
  }> {
    const matches = new Map<string, NominationMatch>();
    const active = await this.referrers.list({
      where: { tenantId: input.tenantId, status: 'active' },
    });
    const activeIds = new Set(active.map((referrer) => referrer.id));
    const aliases = [
      ...tags.emails.map((value) => ({ kind: 'email', value })),
      ...tags.codes.map((value) => ({ kind: 'code', value })),
      ...[...new Set([tags.text, tags.name])].map((value) => ({
        kind: 'name',
        value,
      })),
      ...(tags.text.startsWith('@')
        ? [{ kind: 'handle', value: tags.text }]
        : []),
    ];
    for (const { kind, value } of aliases) {
      if (!value) continue;
      const identifiers = await this.identifiers.list({
        where: {
          tenantId: input.tenantId,
          kind,
          normalizedValue: value,
          status: 'active',
        },
      });
      for (const alias of identifiers) {
        if (
          (alias.programId === null || alias.programId === input.programId) &&
          activeIds.has(alias.referrerId)
        ) {
          matches.set(alias.referrerId, {
            referrerId: alias.referrerId,
            matchedBy: 'identifier',
            matchedIdentifierId: alias.id ?? undefined,
          });
        }
      }
    }
    for (const code of tags.codes) {
      const link = await this.links.findByCode(code);
      if (
        link?.tenantId === input.tenantId &&
        link.programId === input.programId &&
        link.isActive() &&
        activeIds.has(link.referrerId) &&
        !matches.has(link.referrerId)
      ) {
        matches.set(link.referrerId, {
          referrerId: link.referrerId,
          matchedBy: 'link_code',
          linkId: link.id ?? undefined,
          code,
        });
      }
    }
    if (matches.size > 0) {
      const exact = [...matches.values()];
      return {
        match: exact.length === 1 ? exact[0] : undefined,
        candidates: [...matches.keys()].sort(),
      };
    }

    return matchName(active, tags.name);
  }
}

function nominationInputs(input: RecordReferralNominationInput) {
  return {
    nominationText: input.nominationText,
    nominationEmail: input.nominationEmail,
    nominationCode: input.nominationCode,
    actorProfileId: input.actorProfileId,
  };
}

async function inTenant<T>(
  tenantId: string | null,
  run: () => Promise<T>,
): Promise<T> {
  const activeTenant = assertTenantLane(tenantId);
  return tenantId && !activeTenant
    ? await withTenant({ tenantId }, run)
    : await run();
}

function assertTenantLane(tenantId: string | null): string | undefined {
  const activeTenant = getTenantId();
  if (activeTenant && activeTenant !== tenantId) {
    throw new Error('Referral nomination tenant mismatch');
  }
  return activeTenant;
}

function parseNomination(input: RecordReferralNominationInput): NominationTags {
  const text = normalizeIdentifier(input.nominationText);
  const email = normalizeIdentifier(input.nominationEmail ?? '');
  const code = normalizeIdentifier(input.nominationCode ?? '');
  if (
    (input.occurredAt && !Number.isFinite(input.occurredAt.getTime())) ||
    (input.now && !Number.isFinite(input.now.getTime())) ||
    !input.subjectKind.trim() ||
    !input.subjectId.trim() ||
    !(text || email || code) ||
    Buffer.byteLength(
      input.nominationText +
        (input.nominationEmail ?? '') +
        (input.nominationCode ?? ''),
    ) > MAX_NOMINATION_BYTES
  ) {
    throw new Error(
      'Referral nomination requires a subject and at most 1024 bytes of non-empty nomination input',
    );
  }
  const withoutEmails = text.replace(EMAIL, ' ');
  const words = withoutEmails.match(/[\p{L}\p{N}]+/gu) ?? [];
  const emails = [
    ...new Set([email, ...(text.match(EMAIL) ?? [])].filter(Boolean)),
  ];
  const codes = [
    ...new Set(
      [code, ...words.filter((word) => CODE.test(word))].filter(Boolean),
    ),
  ];
  const name = words
    // A standalone word can be a legacy code or a name. Retain the name
    // fallback when it has no exact code match.
    .filter(
      (word) =>
        (word !== code || text === code) &&
        !(CODE.test(word) && /\d/u.test(word)),
    )
    .join(' ');
  return { text, emails, codes, name };
}

function matchName(
  referrers: Referrer[],
  name: string,
): { match?: NominationMatch; candidates: string[] } {
  const words = nameWords(name);
  if (words.length === 0) return { candidates: [] };
  const ranked = referrers
    .flatMap((referrer) =>
      referrer.id
        ? [
            {
              referrerId: referrer.id,
              score: scoreName(words, nameWords(referrer.displayName)),
            },
          ]
        : [],
    )
    .sort(
      (a, b) => b.score - a.score || a.referrerId.localeCompare(b.referrerId),
    );
  const best = ranked[0];
  if (!best || best.score < MIN_NAME_SCORE) return { candidates: [] };
  const contenders = ranked.filter(
    ({ score }) => best.score - score < MIN_NAME_MARGIN,
  );
  return {
    match:
      contenders.length === 1
        ? { referrerId: best.referrerId, matchedBy: 'fuzzy_name' }
        : undefined,
    candidates: contenders.map(({ referrerId }) => referrerId),
  };
}

function nameWords(value: string): string[] {
  return (
    normalizeIdentifier(value)
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .match(/[\p{L}\p{N}]+/gu) ?? []
  );
}

function scoreName(nomination: string[], name: string[]): number {
  if (name.length === 0 || name.length > nomination.length) return 0;
  const expected = name.join(' ');
  let best = 0;
  for (let i = 0; i <= nomination.length - name.length; i += 1) {
    const candidate = nomination.slice(i, i + name.length).join(' ');
    const score =
      1 -
      editDistance(candidate, expected) /
        Math.max(candidate.length, expected.length);
    best = Math.max(best, score);
  }
  return best;
}

function editDistance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 0; i < a.length; i += 1) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j += 1) {
      next.push(
        Math.min(next[j] + 1, row[j + 1] + 1, row[j] + Number(a[i] !== b[j])),
      );
    }
    row = next;
  }
  return row[b.length];
}
