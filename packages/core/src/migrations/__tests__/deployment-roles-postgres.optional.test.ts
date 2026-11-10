/**
 * Platform credential-boundary fixture, not automatic application provisioning.
 * Requires an isolated PostgreSQL administrator URL with CREATEROLE and CREATE
 * SCHEMA privileges (SMRT_TEST_POSTGRES_ADMIN_URL or SMRT_TEST_POSTGRES_URL).
 * Creates unique LOGIN roles/schema, connects as each actual role, then drops
 * only those fixtures. No existing application schemas or grants are changed.
 */
import { randomUUID } from 'node:crypto';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { describe, expect, it, vi } from 'vitest';
import { DeploymentPhaseTracker } from '../deployment-phase-tracker.js';

const pgUrl =
  process.env.SMRT_TEST_POSTGRES_ADMIN_URL ??
  process.env.SMRT_TEST_POSTGRES_URL;
const q = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

describe.skipIf(!pgUrl)(
  'deployment credential boundary (real PostgreSQL)',
  () => {
    it('enforces distinct migration, runtime and SELECT-only monitor authority before deployment mutations', async () => {
      const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
      const schema = `deploy_roles_${suffix}`;
      const roles = {
        migration: `dep_mig_${suffix}`,
        runtime: `dep_run_${suffix}`,
        monitor: `dep_mon_${suffix}`,
      };
      const connections: DatabaseInterface[] = [];
      const createdRoles: string[] = [];
      let schemaCreated = false;
      const admin = await getDatabase({
        type: 'postgres',
        url: pgUrl as string,
        dbid: `dep_admin_${suffix}`,
      });
      try {
        for (const role of Object.values(roles)) {
          await admin.query(
            `CREATE ROLE ${q(role)} LOGIN PASSWORD 'deployment-fixture-password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
          );
          createdRoles.push(role);
          await admin.query(
            `ALTER ROLE ${q(role)} SET search_path = ${q(schema)}`,
          );
        }
        await admin.query(`CREATE SCHEMA ${q(schema)}`);
        schemaCreated = true;
        await admin.query(`REVOKE ALL ON SCHEMA ${q(schema)} FROM PUBLIC`);
        await admin.query(
          `GRANT USAGE ON SCHEMA ${q(schema)} TO ${Object.values(roles).map(q).join(', ')}`,
        );
        await admin.query(
          `GRANT CREATE ON SCHEMA ${q(schema)} TO ${q(roles.migration)}`,
        );
        await admin.query(
          `CREATE TABLE ${q(schema)}.items (id TEXT PRIMARY KEY, value BIGINT NOT NULL)`,
        );
        await admin.query(
          `GRANT SELECT, INSERT, UPDATE, DELETE ON ${q(schema)}.items TO ${q(roles.migration)}, ${q(roles.runtime)}`,
        );
        await admin.query(
          `GRANT SELECT ON ${q(schema)}.items TO ${q(roles.monitor)}`,
        );
        const connect = async (role: string) => {
          const url = new URL(pgUrl as string);
          url.username = role;
          url.password = 'deployment-fixture-password';
          const db = await getDatabase({
            type: 'postgres',
            url: url.toString(),
            dbid: role,
          });
          connections.push(db);
          expect(
            (
              await db.query(
                'SELECT current_user AS role, current_schema() AS schema',
              )
            ).rows[0],
          ).toMatchObject({ role, schema });
          return db;
        };
        const migration = await connect(roles.migration);
        const runtime = await connect(roles.runtime);
        const monitor = await connect(roles.monitor);
        const tracker = new DeploymentPhaseTracker(migration);
        const step = {
          application: suffix,
          environment: 'fixture',
          stepId: 'seed-v1',
          checksum: 'sha256:seed-v1',
          checkSafety: async () => {},
        };
        await tracker.runTransactionalStep(step, async (tx) => {
          await tx.query("INSERT INTO items VALUES ('seed', 1)");
        });
        expect((await tracker.getStepStatus(step))?.status).toBe('complete');
        await admin.query(
          `GRANT SELECT ON ${q(schema)}._smrt_deployment_steps TO ${q(roles.monitor)}`,
        );
        // Runtime can mutate application data, but cannot observe or alter the
        // migration ledger; monitor sees status/data and cannot change either.
        await runtime.query("INSERT INTO items VALUES ('runtime', 2)");
        await runtime.query("UPDATE items SET value = 3 WHERE id = 'runtime'");
        expect(
          (await monitor.query('SELECT * FROM items ORDER BY id')).rows,
        ).toHaveLength(2);
        expect(
          (await new DeploymentPhaseTracker(monitor).getStepStatus(step))
            ?.status,
        ).toBe('complete');
        for (const db of [runtime, monitor]) {
          await expect(
            db.query('DELETE FROM _smrt_deployment_steps'),
          ).rejects.toThrow();
          await expect(
            db.query("UPDATE _smrt_deployment_steps SET status = 'running'"),
          ).rejects.toThrow();
          await expect(
            db.query(
              "INSERT INTO _smrt_deployment_steps(application, environment, step_id, checksum, mode, status) VALUES ('bad', 'bad', 'bad', 'bad', 'transactional', 'complete')",
            ),
          ).rejects.toThrow();
          await expect(
            db.query('CREATE TABLE forbidden (id INTEGER)'),
          ).rejects.toThrow();
          await expect(
            db.query('ALTER TABLE items ADD COLUMN forbidden TEXT'),
          ).rejects.toThrow();
        }
        for (const sql of [
          "INSERT INTO items VALUES ('forbidden', 9)",
          'UPDATE items SET value = 9',
          'DELETE FROM items',
        ]) {
          await expect(monitor.query(sql)).rejects.toThrow();
        }
        // Guard denial happens before ledger DDL or application callback writes.
        const deniedWork = vi.fn(async () => {});
        await expect(
          new DeploymentPhaseTracker(runtime).runTransactionalStep(
            {
              ...step,
              stepId: 'denied-guard',
              checkSafety: async (connection) => {
                await connection.query('SELECT * FROM _smrt_deployment_steps');
              },
            },
            deniedWork,
          ),
        ).rejects.toThrow();
        expect(deniedWork).not.toHaveBeenCalled();
        const mismatchWork = vi.fn(async () => {});
        await expect(
          tracker.runTransactionalStep(
            {
              ...step,
              stepId: 'mismatch-guard',
              checkSafety: async (connection) => {
                const live = await connection.query(
                  "SELECT value FROM items WHERE id = 'seed'",
                );
                if (Number(live.rows[0].value) !== 99)
                  throw new Error('runtime/static agreement refused');
              },
            },
            mismatchWork,
          ),
        ).rejects.toThrow('runtime/static agreement refused');
        expect(mismatchWork).not.toHaveBeenCalled();
        expect(
          await tracker.getStepStatus({ ...step, stepId: 'denied-guard' }),
        ).toBeNull();
        expect(
          await tracker.getStepStatus({ ...step, stepId: 'mismatch-guard' }),
        ).toBeNull();
        expect(
          (await monitor.query('SELECT step_id FROM _smrt_deployment_steps'))
            .rows,
        ).toEqual([{ step_id: 'seed-v1' }]);
        expect(
          (
            await monitor.query(
              'SELECT id, value::integer AS value FROM items ORDER BY id',
            )
          ).rows,
        ).toEqual([
          { id: 'runtime', value: 3 },
          { id: 'seed', value: 1 },
        ]);
      } finally {
        for (const db of connections.reverse()) await db.close?.();
        if (schemaCreated)
          await admin.query(`DROP SCHEMA ${q(schema)} CASCADE`);
        for (const role of createdRoles.reverse())
          await admin.query(`DROP ROLE ${q(role)}`);
        await admin.close?.();
      }
    });
  },
);
