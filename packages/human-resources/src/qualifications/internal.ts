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
 * The decision is made per renewal chain, from the chain's dated history and
 * not from any stored status: the latest row of a chain gets the
 * `employment-ended` revocation, and one event, unless a revocation effective
 * on or before `effectiveOn` is already recorded anywhere in the chain. The
 * rows that latest row renewed are not written: the dated replay cuts them
 * off through the chain. A latest row whose stored status is already
 * `revoked` (a later-dated revocation was recorded) is not saved again; only
 * the change row is appended, and the replay treats the earliest revocation
 * as in force. Returns the latest rows that were cut off.
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
  const byId = new Map(rows.map((row) => [row.id as string, row]));
  const renewed = new Set(rows.map((row) => row.renewalOfId));
  const cut: HeldQualification[] = [];
  for (const row of rows) {
    if (renewed.has(row.id as string)) continue;
    // The earliest revocation recorded on the latest row or any row it renews.
    let already: IsoDate | undefined;
    const seen = new Set<string>();
    for (
      let member: HeldQualification | undefined = row;
      member && !seen.has(member.id as string);
      member = member.renewalOfId ? byId.get(member.renewalOfId) : undefined
    ) {
      seen.add(member.id as string);
      const on = revokedOn.get(member.id as string);
      if (on !== undefined && (already === undefined || on < already))
        already = on;
    }
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
