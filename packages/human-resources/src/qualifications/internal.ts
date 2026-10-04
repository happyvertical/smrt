import type { SmrtObject, SmrtObjectOptions } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { HrEventQueue } from '../service-base.js';
import type { HrActor, IsoDate } from '../types.js';
import { persistHr } from '../write.js';
import {
  type HeldQualification,
  HeldQualificationChange,
  HeldQualificationCollection,
} from './models.js';

/** Reason recorded when an employment-scoped qualification ends with its employment. */
export const EMPLOYMENT_ENDED_REASON = 'employment-ended';

/**
 * Insert one new HR row through the write capability. `collection.create()`
 * saves outside that capability (and so always throws for HR models), and a
 * plain first `save()` would upsert onto an existing natural key; this builds
 * the instance directly and requires a real INSERT.
 */
export async function insertHr<T extends SmrtObject>(
  Model: new (options: SmrtObjectOptions) => T,
  db: DatabaseInterface,
  values: Record<string, unknown>,
): Promise<T> {
  const row = await new Model({ db, _skipLoad: true, ...values }).initialize();
  row.requireInsertOnSave();
  return persistHr(row);
}

/**
 * Revoke every live qualification that belongs to an employment. Called by
 * EmploymentService inside the transaction that ends the employment, so the
 * two never disagree. Person-scoped qualifications are untouched.
 */
export async function revokeEmploymentQualifications(
  db: DatabaseInterface,
  actor: Readonly<HrActor>,
  employmentId: string,
  effectiveOn: IsoDate,
  queue: HrEventQueue,
): Promise<HeldQualification[]> {
  const held = await HeldQualificationCollection.create({ db });
  const live = await held.list({
    where: {
      tenantId: actor.tenantId,
      employmentId,
      status: ['valid', 'suspended'],
    },
  });
  for (const row of live) {
    row.status = 'revoked';
    await persistHr(row);
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
  }
  return live;
}
