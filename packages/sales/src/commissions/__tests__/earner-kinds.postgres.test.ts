/**
 * Earner `kind` and `payoutDestination` (#3834) ship through the
 * manifest-driven migration path (`smrt db:migrate` → `migrateSmrtSchemas`).
 * An `earners` table created before these columns existed, holding a legacy
 * row, migrates to parity: the legacy row reads back as a `person` with no
 * destination, and organisation/treasury earners persist on the migrated
 * table.
 *
 * SQLite runs in the default lane; PostgreSQL when `SMRT_TEST_POSTGRES_URL`
 * is set (`pnpm --filter @happyvertical/smrt-sales test:postgres`).
 */

import { randomUUID } from 'node:crypto';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { migrateSmrtSchemas } from '@happyvertical/smrt-core/migrations';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EarnerCollection } from '../collections/EarnerCollection.js';
import '../models/Earner.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const TABLE = 'earners';
const NEW_COLUMNS = ['kind', 'payout_destination'];

type Engine = 'sqlite' | 'postgres';

function connect(url: string, engine: Engine): Promise<DatabaseInterface> {
  return getDatabase({
    type: engine,
    url,
    ...(engine === 'postgres'
      ? { dbid: `smrt-sales-3834-${randomUUID()}` }
      : {}),
    __smrtSkipVitestSchemaPreparation: true,
  } as Parameters<typeof getDatabase>[0]) as Promise<DatabaseInterface>;
}

/**
 * An empty database: in-memory SQLite, or a disposable PostgreSQL database
 * so the shared suite database's `earners` table and its foreign keys are
 * untouched (the schema differ introspects the `public` schema only).
 */
async function openDb(
  engine: Engine,
): Promise<{ db: DatabaseInterface; cleanup: () => Promise<void> }> {
  if (engine === 'sqlite') {
    const db = await connect(':memory:', engine);
    return { db, cleanup: async () => void (await db.close?.()) };
  }
  const baseUrl = pgUrl as string;
  const admin = await connect(baseUrl, engine);
  const name = `sales_3834_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${name}`);
  let db: DatabaseInterface | undefined;
  const cleanup = async () => {
    try {
      await db?.close?.();
    } finally {
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await admin.close?.();
      }
    }
  };
  try {
    const url = new URL(baseUrl);
    url.pathname = `/${name}`;
    db = await connect(url.toString(), engine);
    return { db, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

for (const { engine, enabled } of [
  { engine: 'sqlite' as const, enabled: true },
  { engine: 'postgres' as const, enabled: Boolean(pgUrl) },
]) {
  describe.skipIf(!enabled)(
    `Earner kind migration on ${engine} (#3834)`,
    () => {
      let cleanup: (() => Promise<void>) | undefined;

      afterEach(async () => {
        vi.restoreAllMocks();
        await cleanup?.();
        cleanup = undefined;
      });

      it('adds kind and payoutDestination to a populated legacy table', async () => {
        const schema = ObjectRegistry.getAllSchemasAsDefinitions()[TABLE];
        if (!schema) throw new Error('earners schema is not registered');
        expect(schema.columns.kind).toBeDefined();
        expect(schema.columns.payout_destination).toBeDefined();
        vi.spyOn(ObjectRegistry, 'getAllSchemasAsDefinitions').mockReturnValue({
          [TABLE]: schema,
        });

        const opened = await openDb(engine);
        cleanup = opened.cleanup;
        const active = opened.db;
        const migrate = () =>
          migrateSmrtSchemas({
            db: active,
            packageName: '@happyvertical/smrt-sales',
            name: `sales_3834_${randomUUID().slice(0, 8)}`,
            ...(engine === 'postgres'
              ? { engineHint: 'postgres' as const, useConcurrentIndexes: false }
              : {}),
          });
        // Build the table exactly as `db:migrate` does, then return it to the
        // pre-#3834 shape: no `kind` or `payout_destination` column.
        expect((await migrate()).applied).toBe(true);
        for (const column of NEW_COLUMNS)
          await active.query(`ALTER TABLE "${TABLE}" DROP COLUMN "${column}"`);
        const legacyId = randomUUID();
        await active.query(
          `INSERT INTO "${TABLE}" (id, slug, context, profile_id, display_name, status, payout_method)
         VALUES (?, ?, '', ?, 'Legacy Grower', 'active', 'paypal')`,
          legacyId,
          `legacy-${legacyId}`,
          randomUUID(),
        );

        const result = await migrate();
        expect(result.hasManualDrift).toBe(false);
        expect(result.applied).toBe(true);
        expect(result.statements.join('\n')).toMatch(/kind/);
        expect(result.statements.join('\n')).toMatch(/payout_destination/);

        const again = await migrate();
        expect(again.applied).toBe(false);
        expect(again.hasManualDrift).toBe(false);

        const earners = await EarnerCollection.create({ db: active });
        const migrated = await earners.get({ id: legacyId });
        expect(migrated?.kind).toBe('person');
        expect(migrated?.getPayoutDestination()).toBeNull();
        expect(migrated?.payoutMethod).toBe('paypal');
        await migrated?.save();

        const treasury = await earners.create({
          kind: 'treasury',
          displayName: 'Valley Co-op Treasury',
          status: 'active',
        });
        const organisation = await earners.create({
          kind: 'organisation',
          displayName: 'Birch Farm',
        });
        organisation.setPayoutDestination({
          method: 'stripe_connect',
          connectedAccountId: 'acct_1BirchFarm',
        });
        organisation.status = 'active';
        await organisation.save();

        const reloaded = await earners.get({ id: organisation.id as string });
        expect(reloaded?.kind).toBe('organisation');
        expect(reloaded?.payoutMethod).toBe('stripe_connect');
        expect(reloaded?.getPayoutDestination()).toEqual({
          method: 'stripe_connect',
          connectedAccountId: 'acct_1BirchFarm',
        });
        expect(
          (await earners.get({ id: treasury.id as string }))?.isTreasury(),
        ).toBe(true);
      });
    },
  );
}
