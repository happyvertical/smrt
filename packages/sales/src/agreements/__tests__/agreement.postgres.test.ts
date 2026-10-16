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

import { agreementHistoryCases } from './agreement-history-cases.js';

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
  it('activates an operator-owned tenant draft without superseding global terms', async () => {
    const tenantId = randomUUID();
    const initial = {
      kind: KIND,
      partyA: JSON.stringify(COOP),
      partyB: JSON.stringify(WORKER),
      version: 1,
      status: 'active' as const,
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
    };
    const global = await agreements.create(initial);
    const prior = await agreements.create({ ...initial, tenantId });
    const draft = await agreements.create({
      ...initial,
      tenantId,
      version: 2,
      status: 'draft',
      effectiveFrom: new Date('2026-02-01T00:00:00Z'),
    });
    await agreements.activateAmendment(draft.id as string);
    expect((await agreements.get({ id: prior.id }))?.status).toBe('superseded');
    expect((await agreements.get({ id: global.id }))?.status).toBe('active');
    expect((await agreements.get({ id: global.id }))?.effectiveTo).toBeNull();
  });
  agreementHistoryCases(
    () => agreements,
    async () => {
      if (!isolated) throw new Error('Missing PostgreSQL fixture');
      // Initial creates use independent commits; an expected unique violation
      // must not abort the shared rollback transaction used by history cases.
      return AgreementCollection.create({ db: isolated.baseDb });
    },
  );
});
