import type { DatabaseInterface } from '@happyvertical/sql';
import type { HrEventQueue } from '../service-base.js';
import type { HrActor, IsoDate } from '../types.js';
import { insertHr, persistHr } from '../write.js';
import {
  type HeldQualification,
  HeldQualificationChange,
  HeldQualificationChangeCollection,
  HeldQualificationCollection,
} from './models.js';

/** Reason recorded when an employment-scoped qualification ends with its employment. */
export const EMPLOYMENT_ENDED_REASON = 'employment-ended';

/**
 * End every qualification that belongs to an employment, from `effectiveOn`
 * (the day after the last day employed). Called by EmploymentService inside
 * the transaction that ends the employment, so the two never disagree.
 * Person-scoped qualifications are untouched.
 *
 * The decision is made from each row's dated history, not its stored status:
 * a row gets the `employment-ended` revocation unless a revocation effective
 * on or before `effectiveOn` is already recorded. That includes a row whose
 * stored status is already `revoked` because a later-dated revocation was
 * recorded; a revoked row never changes, so only the change row is appended
 * for it, and the dated replay then treats the earliest revocation as in
 * force. Returns the rows that were cut off.
 */
export async function revokeEmploymentQualifications(
  db: DatabaseInterface,
  actor: Readonly<HrActor>,
  employmentId: string,
  effectiveOn: IsoDate,
  queue: HrEventQueue,
): Promise<HeldQualification[]> {
  const held = await HeldQualificationCollection.create({ db });
  const rows = await held.list({
    where: { tenantId: actor.tenantId, employmentId },
  });
  if (rows.length === 0) return [];
  const changes = await HeldQualificationChangeCollection.create({ db });
  const revokedOn = new Map<string, IsoDate>();
  for (const change of await changes.list({
    where: {
      tenantId: actor.tenantId,
      heldQualificationId: rows.map((row) => row.id as string),
      kind: 'revoked',
    },
  })) {
    const earliest = revokedOn.get(change.heldQualificationId);
    if (earliest === undefined || change.effectiveOn < earliest)
      revokedOn.set(change.heldQualificationId, change.effectiveOn);
  }
  const cut: HeldQualification[] = [];
  for (const row of rows) {
    const already = revokedOn.get(row.id as string);
    if (already !== undefined && already <= effectiveOn) continue;
    if (row.status !== 'revoked') {
      row.status = 'revoked';
      await persistHr(row);
    }
    await insertHr(HeldQualificationChange, db, {
      tenantId: actor.tenantId,
      heldQualificationId: row.id as string,
      kind: 'revoked',
      effectiveOn,
      reason: EMPLOYMENT_ENDED_REASON,
      actorProfileId: actor.profileId,
    });
    queue({
      type: 'held-qualification.revoked',
      heldQualification: row,
      effectiveOn,
      at: new Date(),
      byProfileId: actor.profileId,
    });
    cut.push(row);
  }
  return cut;
}
