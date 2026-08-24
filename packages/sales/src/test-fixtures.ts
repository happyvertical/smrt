import type { DatabaseInterface } from '@happyvertical/sql';
import { AgreementExecutionCollection } from './agreements/collections/AgreementExecutionCollection.js';
import { ExecutedAgreementCollection } from './agreements/collections/ExecutedAgreementCollection.js';
import { CommissionPayoutCollection } from './commissions/collections/CommissionPayoutCollection.js';
import { EarningEventCollection } from './commissions/collections/EarningEventCollection.js';

/** Create the real execution/evidence parents referenced by agreement fixtures. */
export async function seedAgreementEvidence(
  db: DatabaseInterface,
  executionId: string,
  executedAgreementId: string,
): Promise<void> {
  const executions = await AgreementExecutionCollection.create({ db });
  const executedAgreements = await ExecutedAgreementCollection.create({ db });
  const tenantId = 'fixture-tenant';

  if (!(await executions.get({ id: executionId }))) {
    await executions.create({
      id: executionId,
      tenantId,
      provider: 'fixture',
      idempotencyKey: `fixture:${executionId}`,
      sourceKind: 'referral_agreement',
      sourceId: executedAgreementId,
      status: 'completed',
    });
  }

  if (!(await executedAgreements.get({ id: executedAgreementId }))) {
    await executedAgreements.create({
      id: executedAgreementId,
      tenantId,
      executionId,
      sourceKind: 'referral_agreement',
      sourceId: executedAgreementId,
      acceptedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
  }
}

export async function seedCommissionPayout(
  db: DatabaseInterface,
  earnerId: string,
  payoutId: string,
): Promise<void> {
  const payouts = await CommissionPayoutCollection.create({ db });
  if (await payouts.get({ id: payoutId })) return;
  await payouts.create({
    id: payoutId,
    earnerId,
    currency: 'USD',
    status: 'pending',
    idempotencyKey: `fixture:${payoutId}`,
  });
}

export async function seedEarningEvent(
  db: DatabaseInterface,
  eventId: string,
): Promise<void> {
  const events = await EarningEventCollection.create({ db });
  if (await events.get({ id: eventId })) return;
  await events.create({
    id: eventId,
    eventKind: 'fixture',
    sourceKind: 'fixture',
    sourceId: eventId,
    currency: 'USD',
    dedupeKey: `fixture:${eventId}`,
  });
}
