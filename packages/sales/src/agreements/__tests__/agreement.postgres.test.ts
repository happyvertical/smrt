/** PostgreSQL coverage for agreement interval and historical-resolution semantics. */

import { randomUUID } from 'node:crypto';
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgreementCollection } from '../collections/AgreementCollection.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;
const KIND = 'revenue_share';
const COOP = { kind: 'organization', id: 'worker-coop' };
const WORKER = { kind: 'worker', id: 'worker-17' };

describePostgres('Agreement PostgreSQL effective-dated terms', () => {
  let isolated: IsolatedTestDbResult | undefined;
  let db: DatabaseInterface;
  let agreements: AgreementCollection;

  beforeEach(async () => {
    isolated = await createIsolatedTestDbFromManifest({
      includeObjects: ['Agreement', 'ExecutedAgreement'],
    });
    if (isolated.config.type !== 'postgres') {
      throw new Error('Expected a PostgreSQL test database.');
    }
    db = isolated.db;
    agreements = await AgreementCollection.create({ db });
  });

  afterEach(async () => {
    await isolated?.cleanup();
    isolated = undefined;
  });

  it('hydrates historical terms across an amendment boundary', async () => {
    const partyA = JSON.stringify(COOP);
    const partyB = JSON.stringify(WORKER);
    const v1 = await agreements.create({
      id: randomUUID(),
      kind: KIND,
      partyA,
      partyB,
      version: 1,
      terms: JSON.stringify({ shareFraction: 0.25 }),
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    });
    v1.activate();
    await v1.save();

    const v2 = await agreements.createAmendment(KIND, COOP, WORKER, {
      terms: { shareFraction: 0.35 },
      effectiveFrom: new Date('2026-02-01T00:00:00Z'),
    });
    await agreements.activateAmendment(v2.id as string);

    const prior = await agreements.activeFor(
      KIND,
      COOP,
      WORKER,
      new Date('2026-01-15T00:00:00Z'),
    );
    const current = await agreements.activeFor(
      KIND,
      COOP,
      WORKER,
      new Date('2026-02-01T00:00:00Z'),
    );
    expect(prior?.version).toBe(1);
    expect(prior?.status).toBe('superseded');
    expect(current?.version).toBe(2);
  });

  it('uses the explicit tenant lane without reading a matching tenant', async () => {
    const partyA = JSON.stringify(COOP);
    const partyB = JSON.stringify(WORKER);
    const a = await agreements.create({
      id: randomUUID(),
      tenantId: randomUUID(),
      kind: KIND,
      partyA,
      partyB,
      version: 1,
      status: 'active',
      terms: JSON.stringify({ shareFraction: 0.25 }),
    });
    await agreements.create({
      id: randomUUID(),
      tenantId: randomUUID(),
      kind: KIND,
      partyA,
      partyB,
      version: 1,
      status: 'active',
      terms: JSON.stringify({ shareFraction: 0.75 }),
    });

    const resolved = await agreements.activeFor(
      KIND,
      COOP,
      WORKER,
      new Date(),
      a.tenantId as string,
    );
    expect(resolved?.id).toBe(a.id);
  });
});
