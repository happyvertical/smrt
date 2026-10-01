import { randomUUID } from 'node:crypto';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repairTenantAgentConfigKeys } from '../tenant-agent-config-keys.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const postgresDescribe = pgUrl ? describe.sequential : describe.skip;

postgresDescribe('tenant agent config key repair on PostgreSQL', () => {
  let db: Awaited<ReturnType<typeof getDatabase>>;
  let admin: Awaited<ReturnType<typeof getDatabase>>;
  // Private schema: the package's other suites provision the real tables.
  const schema = `agent_config_keys_${randomUUID().replaceAll('-', '')}`;

  beforeAll(async () => {
    admin = await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid: `smrt-test-config-keys-admin-${randomUUID()}`,
      __smrtSkipVitestSchemaPreparation: true,
    } as Parameters<typeof getDatabase>[0]);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const separator = (pgUrl as string).includes('?') ? '&' : '?';
    db = await getDatabase({
      type: 'postgres',
      url: `${pgUrl}${separator}options=-c%20search_path%3D${schema}`,
      dbid: `smrt-test-config-keys-${randomUUID()}`,
      __smrtSkipVitestSchemaPreparation: true,
    } as Parameters<typeof getDatabase>[0]);
    await db.query(`CREATE TABLE tenant_agents (
      id UUID PRIMARY KEY, tenant_id UUID NOT NULL, agent_class TEXT NOT NULL,
      updated_at TIMESTAMPTZ, UNIQUE (tenant_id, agent_class))`);
    await db.query(`CREATE TABLE agent_configs (
      id UUID PRIMARY KEY, tenant_id UUID, agent_id TEXT NOT NULL,
      agent_class TEXT NOT NULL, slot_id TEXT NOT NULL, slug TEXT NOT NULL,
      updated_at TIMESTAMPTZ)`);
  });

  afterAll(async () => {
    await db?.close?.();
    await admin?.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin?.close?.();
  });

  it('locks, re-keys with uuid tenants, and finds nothing on a second run', async () => {
    const tenant = randomUUID();
    await db.query(
      'INSERT INTO tenant_agents (id, tenant_id, agent_class) VALUES (?, ?, ?)',
      randomUUID(),
      tenant,
      '@legacy/reporter:Reporter',
    );
    await db.query(
      `INSERT INTO agent_configs (id, tenant_id, agent_id, agent_class, slot_id, slug)
       VALUES (?, ?, ?, ?, 'sources', 'old')`,
      randomUUID(),
      tenant,
      `${tenant}:Reporter`,
      'Reporter',
    );
    const aliases = {
      '@legacy/reporter:Reporter': '@example/reporter:Reporter',
      Reporter: '@example/reporter:Reporter',
    };

    const applied = await repairTenantAgentConfigKeys(db, {
      apply: true,
      aliases,
    });
    expect(applied.totals.changed).toBe(2);
    const row = await db.query('SELECT agent_id, slug FROM agent_configs');
    expect(row.rows[0]).toMatchObject({
      agent_id: `${tenant}:@example/reporter:Reporter`,
      slug: `${tenant}:@example/reporter:Reporter-sources`,
    });

    const again = await repairTenantAgentConfigKeys(db, { aliases });
    expect(again.totals.tenantAgents.planned).toBe(0);
    expect(again.totals.configs.planned).toBe(0);
    expect(again.totals.configs.unbound).toBe(0);
  });
});
