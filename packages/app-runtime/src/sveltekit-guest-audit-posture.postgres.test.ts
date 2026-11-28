/**
 * The guest admission catalog check against a real PostgreSQL catalog
 * (#5196, slice H): the audit table must have row-level security enabled and
 * FORCEd and the named guest INSERT policy installed, or guests are refused.
 *
 * One suite, two backends: in-process PGlite (`test:pglite`, sets
 * SMRT_TEST_PGLITE=1) and real PostgreSQL (DATABASE_URL, `test:postgres` and
 * the on-demand validation workflow). Without either it skips cleanly.
 */

import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  assertGuestRuntimeActive,
  GUEST_AUDIT_TABLE_DEFAULTS,
  generatePostgresPermissionSql,
  guestAuditPolicyName,
} from '@happyvertical/smrt-users';
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { probeGuestCatalog } from './sveltekit/guest.js';

const usePglite = process.env.SMRT_TEST_PGLITE === '1';
const describeBackend =
  usePglite || isPostgresAvailable() ? describe : describe.skip;

describeBackend('guest audit posture on a real catalog (#5196)', () => {
  let db: DatabaseInterface;
  let isolated: IsolatedTestDbResult | undefined;

  beforeEach(async () => {
    setConfig({
      packages: {
        users: {
          permissions: {
            guest: {
              collections: ['messages'],
              createCollections: ['messages'],
              createFields: { messages: { allowedFields: ['name'] } },
            },
          },
        },
      },
    });
    if (usePglite) {
      db = await getTestDatabase({
        type: 'pglite',
        url: ':memory:',
        classes: ['AuditLog'],
      });
    } else {
      isolated = await createIsolatedTestDbFromManifest();
      if (isolated.config.type !== 'postgres') {
        throw new Error('Expected a Postgres test database.');
      }
      db = await getDatabase({ type: 'postgres', url: isolated.config.url });
    }
  });

  afterEach(async () => {
    if (!usePglite) {
      try {
        await db.query(
          `DROP POLICY IF EXISTS "${guestAuditPolicyName()}" ON "${GUEST_AUDIT_TABLE_DEFAULTS.tableName}"`,
        );
        await db.query(
          `ALTER TABLE "${GUEST_AUDIT_TABLE_DEFAULTS.tableName}" NO FORCE ROW LEVEL SECURITY, DISABLE ROW LEVEL SECURITY`,
        );
      } catch {
        // best-effort cleanup against a shared test database
      }
    }
    clearCache();
    if (isolated) {
      await isolated.cleanup();
      isolated = undefined;
    }
    const closable = db as unknown as { close?: () => Promise<void> };
    if (closable.close) await closable.close();
  });

  const state = async () => {
    const posture = await probeGuestCatalog(db, [], { audit: true });
    expect(posture).not.toBeNull();
    return posture!;
  };
  const verdict = async () => {
    const posture = await state();
    return assertGuestRuntimeActive({
      postgresRls: true,
      tenancyEnabled: true,
      // The connection role is checked by its own gates; this suite is about
      // the audit table, so present a plain application role.
      rolePosture: { rolsuper: false, rolbypassrls: false },
      ceilingTables: [],
      auditRequired: true,
      auditTable: posture.auditTable,
    });
  };

  async function installDefaultSetup() {
    const generated = generatePostgresPermissionSql({});
    for (const statement of generated.statements) {
      if (
        statement.includes('CREATE OR REPLACE FUNCTION') ||
        statement.includes(`"${GUEST_AUDIT_TABLE_DEFAULTS.tableName}"`)
      ) {
        await db.query(statement);
      }
    }
  }

  it('refuses before setup, accepts after the default setup, refuses on any drift', async () => {
    // A table with no RLS and no policy: refused, with the unmet reason.
    expect((await state()).auditTable).toMatchObject({
      rowSecurity: false,
      forceRowSecurity: false,
      guestInsertPolicy: false,
    });
    expect(await verdict()).toMatchObject({
      active: false,
      reason: 'audit-table-not-protected',
    });

    await installDefaultSetup();
    expect((await state()).auditTable).toMatchObject({
      rowSecurity: true,
      forceRowSecurity: true,
      guestInsertPolicy: true,
    });
    expect(await verdict()).toEqual({ active: true });

    // RLS enabled but not forced (the owner would bypass it).
    await db.query(
      `ALTER TABLE "${GUEST_AUDIT_TABLE_DEFAULTS.tableName}" NO FORCE ROW LEVEL SECURITY`,
    );
    expect(await verdict()).toMatchObject({
      active: false,
      reason: 'audit-table-not-protected',
    });
    await db.query(
      `ALTER TABLE "${GUEST_AUDIT_TABLE_DEFAULTS.tableName}" FORCE ROW LEVEL SECURITY`,
    );
    expect(await verdict()).toEqual({ active: true });

    // The guest policy dropped: refused again.
    await db.query(
      `DROP POLICY "${guestAuditPolicyName()}" ON "${GUEST_AUDIT_TABLE_DEFAULTS.tableName}"`,
    );
    expect(await verdict()).toMatchObject({
      active: false,
      reason: 'audit-table-not-protected',
    });
  });

  it('is unverified when the audit table does not exist', async () => {
    await db.query(`DROP TABLE "${GUEST_AUDIT_TABLE_DEFAULTS.tableName}"`);
    const posture = await probeGuestCatalog(db, [], { audit: true });
    expect(posture?.auditTable).toBeNull();
    expect(
      assertGuestRuntimeActive({
        postgresRls: true,
        tenancyEnabled: true,
        rolePosture: { rolsuper: false, rolbypassrls: false },
        ceilingTables: [],
        auditRequired: true,
        auditTable: posture?.auditTable,
      }),
    ).toMatchObject({ active: false, reason: 'audit-posture-unknown' });
  });
});
