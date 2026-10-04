import type { DatabaseInterface } from '@happyvertical/sql';
import { dateWithin } from '../dates.js';
import type { IsoDate } from '../types.js';
import {
  type Employment,
  EmploymentCollection,
  type EmploymentTerm,
  EmploymentTermCollection,
} from './models.js';

/**
 * Terms that cover `on` for one tenant. Run inside the tenant's scope; the
 * caller supplies a validated date. Shared by both services so "employed on a
 * date" has one definition.
 */
export async function termsCovering(
  db: DatabaseInterface,
  tenantId: string,
  on: IsoDate,
): Promise<EmploymentTerm[]> {
  const terms = await EmploymentTermCollection.create({ db });
  const started = await terms.list({
    where: { tenantId, 'startedOn <=': on },
  });
  return started.filter((term) => dateWithin(on, term.startedOn, term.endedOn));
}

/** Employments with a term covering `on`, for one tenant. */
export async function employmentsOn(
  db: DatabaseInterface,
  tenantId: string,
  on: IsoDate,
): Promise<Employment[]> {
  const ids = [
    ...new Set(
      (await termsCovering(db, tenantId, on)).map((t) => t.employmentId),
    ),
  ];
  if (ids.length === 0) return [];
  const employments = await EmploymentCollection.create({ db });
  return employments.list({ where: { tenantId, id: ids } });
}
