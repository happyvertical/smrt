import { randomUUID } from 'node:crypto';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  AgreementExecutionCollection,
  ExecutedAgreementCollection,
} from '../../agreements/index.js';
import { CommissionPlanCollection } from '../../commissions/index.js';
import {
  AttributionPolicyCollection,
  AttributionService,
  ReferralAgreementCollection,
  ReferralAgreementExecutionService,
  ReferralLinkCollection,
  ReferralNominationResolver,
  ReferralProgramCollection,
  ReferralQualificationService,
  ReferralTouchCollection,
  ReferrerCollection,
  ReferrerIdentifierCollection,
  ReferrerIdentifierConflictError,
  type ResolveReferralNominationInput,
} from '../index.js';

export const nominationObjects = [
  'Referrer',
  'ReferrerIdentifier',
  'ReferralProgram',
  'ReferralLink',
  'ReferralTouch',
  'Referral',
  'AttributionPolicy',
  'AttributionException',
  'AgreementExecution',
  'ExecutedAgreement',
  'ReferralAgreement',
  'CommissionPlan',
  'ReferralTermSnapshot',
];

const NOW = new Date('2026-06-15T00:00:00Z');

export function nominationCases(
  openDb: () => Promise<{ db: DatabaseInterface; close: () => Promise<void> }>,
) {
  let db: DatabaseInterface;
  let close: () => Promise<void>;
  let resolver: ReferralNominationResolver;
  let referrers: ReferrerCollection;
  let programs: ReferralProgramCollection;
  let policies: AttributionPolicyCollection;
  let links: ReferralLinkCollection;
  let identifiers: ReferrerIdentifierCollection;
  let touches: ReferralTouchCollection;
  let tenantId: string;
  let aliceId: string;
  let programId: string;

  beforeEach(async () => {
    enableTenancy();
    ({ db, close } = await openDb());
    referrers = await ReferrerCollection.create({ db });
    programs = await ReferralProgramCollection.create({ db });
    policies = await AttributionPolicyCollection.create({ db });
    links = await ReferralLinkCollection.create({ db });
    identifiers = await ReferrerIdentifierCollection.create({ db });
    touches = await ReferralTouchCollection.create({ db });
    resolver = await ReferralNominationResolver.create({ db });
    tenantId = randomUUID();
    aliceId = await makeReferrer('Alice Baker');
    programId = await makeProgram();
    await policies.create({
      tenantId,
      policyKey: 'nominations',
      version: 1,
      status: 'active',
      windowDays: 30,
      creditMode: 'assigned',
      conflictBehavior: 'auto',
    });
  });

  afterEach(async () => {
    disableTenancy();
    await close?.();
  });

  async function makeReferrer(
    displayName: string,
    owner: string | null = tenantId,
  ) {
    return (
      await referrers.create({
        tenantId: owner,
        profileId: randomUUID(),
        displayName,
        status: 'active',
      })
    ).id as string;
  }

  async function makeProgram(owner: string | null = tenantId) {
    return (
      await programs.create({
        tenantId: owner,
        key: randomUUID(),
        status: 'active',
        defaultAttributionPolicyKey: 'nominations',
      })
    ).id as string;
  }

  function input(nominationText: string): ResolveReferralNominationInput {
    return {
      tenantId,
      programId,
      nominationText,
      subjectKind: 'lead',
      subjectId: randomUUID(),
      targetKind: 'opportunity',
      targetId: randomUUID(),
      now: NOW,
    };
  }

  it('registers a unique alias and reuses normalized intake evidence at attribution', async () => {
    const alias = await identifiers.register({
      tenantId,
      referrerId: aliceId,
      kind: 'Email',
      value: ' ALICE@Example.test ',
      metadata: { verified: true },
    });
    expect(alias).toMatchObject({
      value: ' ALICE@Example.test ',
      kind: 'email',
      normalizedValue: 'alice@example.test',
      programId: null,
    });
    expect(alias.getMetadata()).toEqual({ verified: true });
    expect(
      (
        await identifiers.register({
          tenantId,
          referrerId: aliceId,
          kind: 'email',
          value: 'alice@example.test',
        })
      ).id,
    ).toBe(alias.id);
    const request = input('Alice from ALICE@example.test sent me');
    const recorded = await resolver.recordNomination(request);
    expect(recorded?.getEvidence()).toEqual({
      nominationText: request.nominationText,
      matchedBy: 'identifier',
      matchedIdentifierId: alias.id,
    });
    expect(
      (
        await resolver.recordNomination({
          ...request,
          nominationText: request.nominationText.toLowerCase(),
        })
      )?.id,
    ).toBe(recorded?.id);
    const result = await resolver.resolve(request);
    expect(result.referrals).toMatchObject([
      {
        referrerId: aliceId,
        primaryTouchId: recorded?.id,
        status: 'attributed',
      },
    ]);
    expect((await resolver.resolve(request)).referrals[0]?.id).toBe(
      result.referrals[0]?.id,
    );
    expect(
      await touches.findBySubject(request.subjectKind, request.subjectId),
    ).toHaveLength(1);

    const otherReferrer = await makeReferrer('Other Referrer');
    await expect(
      identifiers.register({
        tenantId,
        referrerId: otherReferrer,
        kind: 'email',
        value: alias.value,
      }),
    ).rejects.toBeInstanceOf(ReferrerIdentifierConflictError);
    alias.disable();
    await alias.save();
    expect(
      await resolver.recordNomination(input('alice@example.test')),
    ).toBeNull();
    alias.status = 'active';
    await expect(alias.save()).rejects.toThrow('append-only');
    await expect(alias.delete()).rejects.toThrow('append-only');
  });

  it('matches active codes and uniquely confident names, but ignores inactive and wrong-program links', async () => {
    const link = await links.createWithUniqueCode({
      tenantId,
      programId,
      referrerId: aliceId,
      targetUrl: 'https://example.test/',
    });
    const code = await resolver.recordNomination(
      input(`Use ${link.code.toUpperCase()}`),
    );
    expect(code).toMatchObject({
      referrerId: aliceId,
      linkId: link.id,
      code: link.code,
    });
    expect(code?.getEvidence().matchedBy).toBe('link_code');
    expect(
      await resolver.recordNomination({
        ...input(link.code),
        programId: await makeProgram(),
      }),
    ).toBeNull();

    link.status = 'disabled';
    await link.save();
    expect(await resolver.recordNomination(input(link.code))).toBeNull();

    const fuzzy = await resolver.recordNomination(
      input('I heard about you from Alise Baker'),
    );
    expect(fuzzy?.referrerId).toBe(aliceId);
    expect(fuzzy?.getEvidence().matchedBy).toBe('fuzzy_name');
    const solo = await makeReferrer('Jordan');
    expect(
      await resolver.recordNomination({
        ...input('Jordan'),
        nominationCode: 'Jordan',
      }),
    ).toMatchObject({ referrerId: solo });
    const alias = await identifiers.register({
      tenantId,
      referrerId: aliceId,
      programId,
      kind: 'name',
      value: 'Alice O’Neil',
    });
    const exact = await resolver.recordNomination(input('Alice O’Neil'));
    expect(exact?.getEvidence()).toMatchObject({
      matchedBy: 'identifier',
      matchedIdentifierId: alias.id,
    });
  });

  it('parks ambiguous or unmatched nominations without minting touches and preserves their policy pin', async () => {
    const other = await makeReferrer('Alice Baker');
    const request = input('Alice Baker mentioned you');
    const conflict = await resolver.resolve(request);
    expect(conflict.exception?.conflictReason).toBe('nomination_unresolved');
    expect(conflict.exception?.getCandidates()).toEqual(
      [aliceId, other].sort().map((referrerId) => ({
        touchId: '',
        kind: 'nomination',
        occurredAt: NOW.toISOString(),
        referrerId,
      })),
    );
    expect(conflict.exception?.getMetadata()).toMatchObject({
      nominationText: request.nominationText,
      policyKey: 'nominations',
      policyVersion: 1,
      windowDays: 30,
    });
    expect((await resolver.resolve(request)).exception?.id).toBe(
      conflict.exception?.id,
    );
    expect(
      await touches.findBySubject(request.subjectKind, request.subjectId),
    ).toHaveLength(0);

    const unknown = await resolver.resolve(input('Completely unknown'));
    expect(unknown.exception?.getCandidates()).toEqual([]);
    const attribution = await AttributionService.create({ db });
    const exceptionId = unknown.exception?.id as string;
    const award = await attribution.resolveException({
      exceptionId,
      awards: [{ referrerId: aliceId, creditFraction: 1 }],
      resolutionReason: 'Confirmed introduction',
      actorProfileId: randomUUID(),
      now: NOW,
    });
    expect(award.referrals).toMatchObject([
      { referrerId: aliceId, policyVersion: 1, status: 'attributed' },
    ]);
    await expect(
      resolver.registerResolvedIdentifier({
        tenantId,
        exceptionId,
        referrerId: other,
        kind: 'name',
        value: 'Completely unknown',
      }),
    ).rejects.toThrow('did not receive credit');
    const alias = await resolver.registerResolvedIdentifier({
      tenantId,
      exceptionId,
      referrerId: aliceId,
      kind: 'name',
      value: 'Completely unknown',
    });
    expect(alias.getMetadata()).toMatchObject({
      nominationExceptionId: exceptionId,
    });
    expect(
      (await resolver.recordNomination(input('Completely unknown')))
        ?.referrerId,
    ).toBe(aliceId);
  });

  it('qualifies operator-awarded credit under provider-free executed terms and replays it', async () => {
    const request = input('A verified introduction');
    const unresolved = await resolver.resolve(request);
    await withTenant({ tenantId }, async () => {
      const plans = await CommissionPlanCollection.create({ db });
      await plans.create({
        planKey: 'confirmed-plan',
        version: 1,
        status: 'active',
        currency: 'USD',
        components: JSON.stringify([
          {
            key: 'sales',
            trigger: 'invoice_payment',
            basis: 'gross',
            rate: 0.1,
          },
        ]),
      });
      const agreements = await ReferralAgreementCollection.create({ db });
      const executions = await AgreementExecutionCollection.create({ db });
      const executedAgreements = await ExecutedAgreementCollection.create({
        db,
      });
      const agreement = await agreements.create({
        referrerId: aliceId,
        programId,
        version: 1,
        status: 'draft',
        commissionPlanKey: 'confirmed-plan',
        commissionPlanVersion: 1,
      });
      const source = {
        sourceKind: 'referral_agreement',
        sourceId: agreement.id as string,
        sourceVersion: 1,
      };
      const execution = await executions.create({
        ...source,
        idempotencyKey: randomUUID(),
        provider: 'clickwrap',
        status: 'completed',
      });
      const { agreement: evidence } = await executedAgreements.createImmutable({
        ...source,
        tenantId,
        executionId: execution.id as string,
        sourceAssetId: randomUUID(),
        sourceSha256: 'source-hash',
        sourceSizeBytes: 100,
        signedDocumentAssetId: randomUUID(),
        signedDocumentSha256: 'signed-hash',
        signedDocumentSizeBytes: 120,
        signedDocumentMediaType: 'text/plain',
        signedDocumentFilename: 'accepted.txt',
        auditTrailAssetId: randomUUID(),
        auditTrailSha256: 'audit-hash',
        auditTrailSizeBytes: 80,
        auditTrailMediaType: 'application/json',
        auditTrailFilename: 'acceptance.json',
        signerEvidence: JSON.stringify([
          { email: 'signer@example.test', status: 'signed' },
        ]),
        acceptedAt: NOW,
      });
      agreement.bindExecution(execution.id as string);
      await agreement.save();
      const executionBinding = new ReferralAgreementExecutionService({
        agreements,
        executions,
        executedAgreements,
      });
      await executionBinding.applyExecutedAgreement({
        tenantId,
        agreementId: agreement.id as string,
        executedAgreementId: evidence.id as string,
        at: NOW,
      });

      const attribution = await AttributionService.create({ db });
      const awarded = await attribution.resolveException({
        exceptionId: unresolved.exception?.id as string,
        awards: [{ referrerId: aliceId, creditFraction: 1 }],
        resolutionReason: 'Confirmed introduction',
        actorProfileId: randomUUID(),
        now: NOW,
      });
      const qualification = await ReferralQualificationService.create({ db });
      const qualified = await qualification.qualify({
        referralId: awarded.referrals[0].id as string,
        now: NOW,
      });
      expect(qualified).toMatchObject({
        qualified: true,
        snapshot: { policyVersion: 1, planVersion: 1 },
      });
      expect((await resolver.resolve(request)).referrals).toMatchObject([
        { id: awarded.referrals[0].id, status: 'qualified' },
      ]);
    });
  });

  it('isolates program, referrer, and identifier matches with and without ambient tenant context', async () => {
    const foreignTenant = randomUUID();
    const foreignReferrer = await makeReferrer(
      'Foreign Referrer',
      foreignTenant,
    );
    const foreignProgram = await makeProgram(foreignTenant);
    await identifiers.register({
      tenantId: foreignTenant,
      referrerId: foreignReferrer,
      kind: 'email',
      value: 'person@example.test',
    });
    expect(
      await resolver.recordNomination(input('person@example.test')),
    ).toBeNull();
    expect(
      await resolver.recordNomination(input('Foreign Referrer')),
    ).toBeNull();
    await expect(
      resolver.resolve({
        ...input('Foreign Referrer'),
        programId: foreignProgram,
      }),
    ).rejects.toThrow('same tenant');
    await expect(
      withTenant({ tenantId }, () =>
        resolver.resolve({
          ...input('Foreign Referrer'),
          tenantId: foreignTenant,
          programId: foreignProgram,
        }),
      ),
    ).rejects.toThrow('tenant mismatch');
    await expect(
      identifiers.register({
        tenantId,
        referrerId: foreignReferrer,
        kind: 'email',
        value: 'person@example.test',
      }),
    ).rejects.toThrow('referrer in the same tenant');
    await expect(
      identifiers.register({
        tenantId,
        referrerId: aliceId,
        programId: foreignProgram,
        kind: 'email',
        value: 'person@example.test',
      }),
    ).rejects.toThrow('program in the same tenant');
    await identifiers.register({
      tenantId,
      referrerId: aliceId,
      kind: 'email',
      value: 'person@example.test',
    });
    expect(
      (await resolver.recordNomination(input('person@example.test')))
        ?.referrerId,
    ).toBe(aliceId);
    const unresolved = await resolver.resolve(input('Unknown introducer'));
    const attribution = await AttributionService.create({ db });
    await expect(
      attribution.resolveException({
        exceptionId: unresolved.exception?.id as string,
        awards: [{ referrerId: foreignReferrer, creditFraction: 1 }],
        resolutionReason: 'Attempt to cross tenants',
        actorProfileId: randomUUID(),
      }),
    ).rejects.toThrow('active referrers in the same tenant');
  });

  it('retains the global policy fallback for a tenant-owned program in background resolution', async () => {
    const policyKey = 'global-nomination-policy';
    for (const [owner, version] of [
      [null, 1],
      [randomUUID(), 2],
    ] as const) {
      await policies.create({
        tenantId: owner,
        policyKey,
        version,
        status: 'active',
        windowDays: 30,
        creditMode: 'assigned',
      });
    }
    const program = await programs.create({
      tenantId,
      key: randomUUID(),
      status: 'active',
      defaultAttributionPolicyKey: policyKey,
    });
    const result = await resolver.resolve({
      ...input('Alice Baker'),
      programId: program.id as string,
    });
    expect(result.referrals).toMatchObject([
      {
        tenantId,
        referrerId: aliceId,
        policyKey,
        policyVersion: 1,
      },
    ]);
  });

  it('checks every award when a matched nomination competes with a manual assignment', async () => {
    const request = input('Alice Baker');
    const competingReferrer = await makeReferrer('Another Referrer');
    const inactiveId = await makeReferrer('Inactive Referrer');
    const inactive = await referrers.get({ id: inactiveId });
    if (!inactive) throw new Error('Missing inactive referrer fixture');
    inactive.status = 'suspended';
    await inactive.save();
    const foreignId = await makeReferrer('Foreign Referrer', randomUUID());
    const attribution = await AttributionService.create({ db });
    const actorProfileId = randomUUID();
    await attribution.recordManualAssignment({
      ...request,
      referrerId: competingReferrer,
      actorProfileId,
      occurredAt: NOW,
    });
    const conflict = await resolver.resolve(request);
    expect(conflict.exception?.conflictReason).toBe('competing_touches');
    expect(
      conflict.exception?.getCandidates().map(({ kind }) => kind),
    ).toContain('nomination');

    const award = (referrerId: string) =>
      attribution.resolveException({
        exceptionId: conflict.exception?.id as string,
        awards: [{ referrerId, creditFraction: 1 }],
        resolutionReason: 'Confirmed introduction',
        actorProfileId,
        now: NOW,
      });
    await expect(award(foreignId)).rejects.toThrow(
      'active referrers in the same tenant',
    );
    await expect(award(inactiveId)).rejects.toThrow(
      'active referrers in the same tenant',
    );
    expect((await resolver.resolve(request)).exception?.id).toBe(
      conflict.exception?.id,
    );
    expect((await award(aliceId)).referrals).toMatchObject([
      { referrerId: aliceId, status: 'attributed' },
    ]);
  });

  it('keeps global identifiers unique and excludes tenant-owned aliases from the global lane', async () => {
    const globalReferrer = await makeReferrer('Global Referrer', null);
    const globalProgram = await makeProgram(null);
    const globalInput = {
      ...input('global@example.test'),
      tenantId: null,
      programId: globalProgram,
    };
    await identifiers.register({
      tenantId,
      referrerId: aliceId,
      kind: 'email',
      value: globalInput.nominationText,
    });
    expect(await resolver.recordNomination(globalInput)).toBeNull();
    const globalAlias = await identifiers.register({
      tenantId: null,
      referrerId: globalReferrer,
      kind: 'email',
      value: globalInput.nominationText,
    });
    expect((await resolver.recordNomination(globalInput))?.referrerId).toBe(
      globalReferrer,
    );
    await expect(
      identifiers.create({
        tenantId: null,
        referrerId: globalReferrer,
        kind: 'email',
        value: globalAlias.value,
      }),
    ).rejects.toThrow();
  });

  it('honors caller rollback and refuses malformed or stale nominations', async () => {
    const request = input('Alice Baker');
    const transaction = db.transaction?.bind(db);
    if (!transaction) throw new Error('Expected transaction-capable database');
    await expect(
      transaction(async (tx) => {
        const scoped = await ReferralNominationResolver.create({
          db: tx,
          _reuseInitializedDb: true,
          _deferRuntimeInitialization: true,
        });
        expect((await scoped.resolve(request)).referrals).toHaveLength(1);
        throw new Error('roll back nomination');
      }),
    ).rejects.toThrow('roll back nomination');
    expect(
      await touches.findBySubject(request.subjectKind, request.subjectId),
    ).toHaveLength(0);
    expect((await resolver.resolve(request)).referrals).toHaveLength(1);
    await expect(resolver.recordNomination(input(' '))).rejects.toThrow(
      'non-empty nomination',
    );
    await expect(
      resolver.recordNomination(input('x'.repeat(1025))),
    ).rejects.toThrow('1024 bytes');
    expect(
      await resolver.resolve({
        ...input('unknown'),
        occurredAt: new Date('2026-01-01'),
      }),
    ).toMatchObject({
      exception: null,
      refused: 'no_eligible_touches',
    });
  });
}
