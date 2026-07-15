/** ReferralAgreement binding for the provider-neutral execution service. */

import type {
  SignatureDocument,
  SignatureSignerInput,
} from '@happyvertical/signatures';
import { requireTenantId } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { AgreementExecutionCollection } from '../../agreements/collections/AgreementExecutionCollection.js';
import type { ExecutedAgreementCollection } from '../../agreements/collections/ExecutedAgreementCollection.js';
import type { AgreementExecutionService } from '../../agreements/services/AgreementExecutionService.js';
import type { AgreementExecutionResult } from '../../agreements/types.js';
import { ReferralAgreementCollection } from '../collections/ReferralAgreementCollection.js';
import type { ReferralAgreement } from '../models/ReferralAgreement.js';

export const REFERRAL_AGREEMENT_SOURCE_KIND = 'referral_agreement';

export interface ReferralAgreementExecutionServiceDeps {
  agreements: ReferralAgreementCollection;
  executions: AgreementExecutionCollection;
  executedAgreements: ExecutedAgreementCollection;
  executionService: AgreementExecutionService;
  now?: () => Date;
}

export interface RequestReferralAgreementSignatureInput {
  tenantId: string;
  agreementId: string;
  document: SignatureDocument;
  signers: readonly SignatureSignerInput[];
  title?: string;
  message?: string;
  signingOrder?: boolean;
  expiresInDays?: number;
  providerAccountRef?: string;
  credentialRef?: string;
  signal?: AbortSignal;
}

export interface ApplyExecutedReferralAgreementInput {
  tenantId: string;
  agreementId: string;
  executedAgreementId?: string;
  at?: Date;
}

interface TransactionCapableDatabase extends DatabaseInterface {
  transaction?<T>(fn: (tx: DatabaseInterface) => Promise<T>): Promise<T>;
}

export class ReferralAgreementExecutionService {
  private readonly now: () => Date;

  constructor(private readonly deps: ReferralAgreementExecutionServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async requestSignature(
    input: RequestReferralAgreementSignatureInput,
  ): Promise<AgreementExecutionResult> {
    this.assertTenant(input.tenantId);
    const agreement = await this.requireAgreement(input.agreementId);
    this.assertAgreementTenant(agreement, input.tenantId);
    if (!agreement.id || agreement.status !== 'draft') {
      throw new Error('Only a persisted draft ReferralAgreement can be sent');
    }
    if (agreement.executedAgreementId) {
      throw new Error(
        'ReferralAgreement already has immutable executed evidence',
      );
    }

    const prior = await this.findPriorActive(agreement);
    const idempotencyKey = `${input.tenantId}:${REFERRAL_AGREEMENT_SOURCE_KIND}:${agreement.id}:v${agreement.version}`;
    let result: AgreementExecutionResult;
    try {
      result = await this.deps.executionService.createExecution({
        tenantId: input.tenantId,
        idempotencyKey,
        sourceKind: REFERRAL_AGREEMENT_SOURCE_KIND,
        sourceId: agreement.id,
        sourceVersion: agreement.version,
        title: input.title ?? `Referral Agreement v${agreement.version}`,
        document: input.document,
        signers: input.signers,
        ...(input.message ? { message: input.message } : {}),
        ...(input.signingOrder !== undefined
          ? { signingOrder: input.signingOrder }
          : {}),
        ...(input.expiresInDays !== undefined
          ? { expiresInDays: input.expiresInDays }
          : {}),
        ...(input.providerAccountRef
          ? { providerAccountRef: input.providerAccountRef }
          : {}),
        ...(input.credentialRef ? { credentialRef: input.credentialRef } : {}),
        effectiveFrom: agreement.effectiveFrom,
        effectiveTo: agreement.effectiveTo,
        supersedesExecutedAgreementId: prior?.executedAgreementId ?? '',
        metadata: {
          referralAgreementId: agreement.id,
          referralAgreementVersion: String(agreement.version),
          referrerId: agreement.referrerId,
          programId: agreement.programId,
        },
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (error) {
      // A failed or uncertain provider call may still have persisted the
      // execution fence. Bind it so operators can reconcile/adopt safely by
      // Referral Agreement without issuing another remote request.
      const persisted =
        await this.deps.executions.findByIdempotencyKey(idempotencyKey);
      if (persisted?.id) {
        agreement.bindExecution(persisted.id);
        await agreement.save();
      }
      throw error;
    }
    agreement.bindExecution(result.executionId);
    await agreement.save();
    return result;
  }

  /**
   * Bind completed immutable evidence, activate the signed version, and end
   * the prior active version only when the new effective date has arrived.
   */
  async applyExecutedAgreement(
    input: ApplyExecutedReferralAgreementInput,
  ): Promise<ReferralAgreement> {
    this.assertTenant(input.tenantId);
    const loaded = await this.requireAgreement(input.agreementId);
    this.assertAgreementTenant(loaded, input.tenantId);
    if (!loaded.executionId) {
      throw new Error('ReferralAgreement has no AgreementExecution');
    }
    const executed = input.executedAgreementId
      ? await this.deps.executedAgreements.get({
          id: input.executedAgreementId,
        })
      : await this.deps.executedAgreements.findByExecution(loaded.executionId);
    if (!executed?.id) {
      throw new Error(
        'Completed immutable ExecutedAgreement evidence was not found',
      );
    }
    const executedId = executed.id;
    if (
      executed.executionId !== loaded.executionId ||
      executed.sourceKind !== REFERRAL_AGREEMENT_SOURCE_KIND ||
      executed.sourceId !== loaded.id ||
      executed.sourceVersion !== loaded.version ||
      executed.tenantId !== input.tenantId
    ) {
      throw new Error(
        'ExecutedAgreement does not belong to this ReferralAgreement version',
      );
    }

    const at = input.at ?? this.now();
    const agreementId = await this.runTransaction(async (agreements) => {
      const agreement = await agreements.get({ id: input.agreementId });
      if (!agreement) throw new Error('ReferralAgreement disappeared');
      if (
        agreement.status === 'active' &&
        agreement.executedAgreementId === executedId
      ) {
        return agreement.id as string;
      }
      if (agreement.status !== 'draft') {
        throw new Error(
          `ReferralAgreement cannot accept executed evidence from status '${agreement.status}'`,
        );
      }
      agreement.bindExecutedAgreement(executedId);
      agreement.effectiveFrom ??= executed.effectiveFrom;
      agreement.activate();
      await agreement.save();

      if (!agreement.effectiveFrom || agreement.effectiveFrom <= at) {
        await this.supersedePriors(agreements, agreement, at);
      }
      return agreement.id as string;
    });
    return await this.requireAgreement(agreementId);
  }

  /** Scheduled/reconciliation hook for future-dated signed amendments. */
  async supersedePriorIfEffective(
    input: ApplyExecutedReferralAgreementInput,
  ): Promise<ReferralAgreement> {
    this.assertTenant(input.tenantId);
    const at = input.at ?? this.now();
    const agreementId = await this.runTransaction(async (agreements) => {
      const agreement = await agreements.get({ id: input.agreementId });
      if (agreement?.status !== 'active') {
        throw new Error('Signed active ReferralAgreement was not found');
      }
      this.assertAgreementTenant(agreement, input.tenantId);
      if (agreement.effectiveFrom && agreement.effectiveFrom > at) {
        return agreement.id as string;
      }
      await this.supersedePriors(agreements, agreement, at);
      return agreement.id as string;
    });
    return await this.requireAgreement(agreementId);
  }

  private async supersedePriors(
    agreements: ReferralAgreementCollection,
    agreement: ReferralAgreement,
    at: Date,
  ): Promise<void> {
    const versions = await agreements.findByReferrerAndProgram(
      agreement.referrerId,
      agreement.programId,
    );
    const priors = versions.filter(
      (candidate) =>
        candidate.id !== agreement.id &&
        candidate.status === 'active' &&
        candidate.version < agreement.version,
    );
    for (const prior of priors) {
      prior.effectiveTo = agreement.effectiveFrom ?? at;
      prior.supersede();
      await prior.save();
    }
  }

  private async findPriorActive(
    agreement: ReferralAgreement,
  ): Promise<ReferralAgreement | null> {
    const versions = await this.deps.agreements.findByReferrerAndProgram(
      agreement.referrerId,
      agreement.programId,
    );
    return (
      versions.find(
        (candidate) =>
          candidate.id !== agreement.id &&
          candidate.status === 'active' &&
          candidate.version < agreement.version,
      ) ?? null
    );
  }

  private async requireAgreement(id: string): Promise<ReferralAgreement> {
    const agreement = await this.deps.agreements.get({ id });
    if (!agreement) throw new Error(`ReferralAgreement '${id}' was not found`);
    return agreement;
  }

  private async runTransaction<T>(
    fn: (agreements: ReferralAgreementCollection) => Promise<T>,
  ): Promise<T> {
    const db = this.deps.agreements.db as TransactionCapableDatabase;
    if (typeof db.transaction !== 'function')
      return await fn(this.deps.agreements);
    return await db.transaction(async (tx) =>
      fn(await ReferralAgreementCollection.create({ db: tx })),
    );
  }

  private assertTenant(tenantId: string): void {
    if (requireTenantId() !== tenantId) {
      throw new Error('ReferralAgreement execution tenant mismatch');
    }
  }

  private assertAgreementTenant(
    agreement: ReferralAgreement,
    tenantId: string,
  ): void {
    if (agreement.tenantId !== tenantId) {
      throw new Error('ReferralAgreement does not belong to the active tenant');
    }
  }
}

export default ReferralAgreementExecutionService;
