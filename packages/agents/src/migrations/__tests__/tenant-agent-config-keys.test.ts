import { getTestDatabase, smrt } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Agent } from '../../agent.js';
import {
  getAgentTypeName,
  parseTenantAgentConfigOwnerId,
  tenantAgentConfigOwnerId,
} from '../../identity.js';
import { serializeResolvedAgent } from '../../server/serialization.js';
import {
  planTenantAgentConfigKeyRepairRows,
  repairTenantAgentConfigKeys,
  TenantAgentConfigKeyRepairError,
} from '../tenant-agent-config-keys.js';

@smrt()
class KeyRepairReporter extends Agent {
  protected config = {};

  async run(): Promise<void> {}
}

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';
const RENAMED = '@legacy/reporter:Reporter';
const RENAMED_TARGET = '@example/reporter:Reporter';

describe('tenant agent config owner id', () => {
  it('composes <tenant>:<canonical type> and parses it back', () => {
    const canonical = getAgentTypeName('KeyRepairReporter');
    expect(canonical).toContain(':KeyRepairReporter');
    expect(tenantAgentConfigOwnerId(T1, 'KeyRepairReporter')).toBe(
      `${T1}:${canonical}`,
    );
    expect(tenantAgentConfigOwnerId(T1, canonical)).toBe(`${T1}:${canonical}`);
    expect(parseTenantAgentConfigOwnerId(`${T1}:${canonical}`, T1)).toBe(
      canonical,
    );
    expect(parseTenantAgentConfigOwnerId(`${T1}:${canonical}`, T2)).toBeNull();
    expect(parseTenantAgentConfigOwnerId('persona-uuid', T1)).toBeNull();
  });

  it('is the id serializeResolvedAgent gives a binding without an agent row', () => {
    const canonical = getAgentTypeName('KeyRepairReporter');
    const serialized = serializeResolvedAgent({
      agentClass: 'KeyRepairReporter',
      agentType: canonical,
      status: 'active',
      source: 'explicit',
      sourceTenantId: T1,
      permissions: {},
    });
    expect(serialized.id).toBe(tenantAgentConfigOwnerId(T1, canonical));
  });
});

describe('planTenantAgentConfigKeyRepairRows', () => {
  const canonical = () => getAgentTypeName('KeyRepairReporter');

  it('re-keys bare-class and aliased owners and leaves other owners alone', () => {
    const plan = planTenantAgentConfigKeyRepairRows(
      [
        { id: 'b1', tenant_id: T1, agent_class: 'KeyRepairReporter' },
        { id: 'b2', tenant_id: T2, agent_class: RENAMED },
      ],
      [
        {
          id: 'c1',
          tenant_id: T1,
          agent_id: `${T1}:KeyRepairReporter`,
          agent_class: 'KeyRepairReporter',
          slot_id: 'sources',
          slug: `${T1}:KeyRepairReporter-sources`,
        },
        {
          id: 'c2',
          tenant_id: T2,
          agent_id: `${T2}:${RENAMED}`,
          agent_class: RENAMED,
          slot_id: 'settings',
          slug: 'whatever',
        },
        {
          id: 'c3',
          tenant_id: T1,
          agent_id: 'persona-1',
          agent_class: 'KeyRepairReporter',
          slot_id: 'sources',
          slug: 'persona-1-sources',
        },
        {
          id: 'c4',
          tenant_id: null,
          agent_id: `${T1}:KeyRepairReporter`,
          agent_class: 'KeyRepairReporter',
          slot_id: 'x',
          slug: 'x',
        },
      ],
      { aliases: { [RENAMED]: RENAMED_TARGET } },
    );

    expect(
      plan.tenantAgents.planned.map((row) => row.targetAgentClass),
    ).toEqual([canonical(), RENAMED_TARGET]);
    expect(
      plan.configs.planned.map((row) => [
        row.id,
        row.targetAgentId,
        row.targetSlug,
      ]),
    ).toEqual([
      ['c1', `${T1}:${canonical()}`, `${T1}:${canonical()}-sources`],
      ['c2', `${T2}:${RENAMED_TARGET}`, `${T2}:${RENAMED_TARGET}-settings`],
    ]);
    expect(plan.configs.planned.every((row) => !row.unbound)).toBe(true);
    expect(plan.configs.skipped.map((row) => row.id).sort()).toEqual([
      'c3',
      'c4',
    ]);
  });

  it('blocks two spellings of one binding or one slot', () => {
    const plan = planTenantAgentConfigKeyRepairRows(
      [
        { id: 'b1', tenant_id: T1, agent_class: 'KeyRepairReporter' },
        { id: 'b2', tenant_id: T1, agent_class: canonical() },
      ],
      [
        {
          id: 'c1',
          tenant_id: T1,
          agent_id: `${T1}:KeyRepairReporter`,
          agent_class: 'KeyRepairReporter',
          slot_id: 'sources',
          slug: 'a',
        },
        {
          id: 'c2',
          tenant_id: T1,
          agent_id: `${T1}:${canonical()}`,
          agent_class: canonical(),
          slot_id: 'sources',
          slug: 'b',
        },
      ],
    );
    expect(plan.tenantAgents.blocked).toHaveLength(2);
    expect(plan.configs.blocked.map((row) => row.id).sort()).toEqual([
      'c1',
      'c2',
    ]);
    expect(plan.configs.planned).toEqual([]);
  });
});

describe('repairTenantAgentConfigKeys', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    db = await getTestDatabase({ classes: ['TenantAgent', 'AgentConfig'] });
  });

  afterEach(async () => {
    await db.close?.();
  });

  async function seed(): Promise<void> {
    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO tenant_agents (id, slug, context, tenant_id, agent_class, status, created_at, updated_at)
       VALUES (?, ?, '', ?, ?, 'active', ?, ?)`,
      'b1',
      'b1',
      T1,
      'KeyRepairReporter',
      now,
      now,
    );
    await db.query(
      `INSERT INTO agent_configs (id, slug, context, tenant_id, agent_id, agent_class, slot_id, config_data, created_at, updated_at)
       VALUES (?, ?, '', ?, ?, ?, ?, '{}', ?, ?)`,
      'c1',
      `${T1}:KeyRepairReporter-sources`,
      T1,
      `${T1}:KeyRepairReporter`,
      'KeyRepairReporter',
      'sources',
      now,
      now,
    );
  }

  it('dry-runs without writing, applies with a ledger, and is idempotent', async () => {
    await seed();
    const canonical = getAgentTypeName('KeyRepairReporter');

    const dry = await repairTenantAgentConfigKeys(db);
    expect(dry.mode).toBe('dry-run');
    expect(dry.totals.tenantAgents.planned).toBe(1);
    expect(dry.totals.configs.planned).toBe(1);
    expect(dry.totals.changed).toBe(0);
    const untouched = await db.query('SELECT agent_id FROM agent_configs');
    expect(untouched.rows[0]).toMatchObject({
      agent_id: `${T1}:KeyRepairReporter`,
    });

    const applied = await repairTenantAgentConfigKeys(db, { apply: true });
    expect(applied.mode).toBe('apply');
    expect(applied.totals.changed).toBe(2);
    expect(applied.ledger.map((entry) => entry.table)).toEqual([
      'tenant_agents',
      'agent_configs',
    ]);
    const config = await db.query(
      'SELECT agent_id, agent_class, slug FROM agent_configs',
    );
    expect(config.rows[0]).toMatchObject({
      agent_id: tenantAgentConfigOwnerId(T1, 'KeyRepairReporter'),
      agent_class: canonical,
      slug: `${tenantAgentConfigOwnerId(T1, 'KeyRepairReporter')}-sources`,
    });
    const binding = await db.query('SELECT agent_class FROM tenant_agents');
    expect(binding.rows[0]).toMatchObject({ agent_class: canonical });

    const again = await repairTenantAgentConfigKeys(db, { apply: true });
    expect(again.totals.changed).toBe(0);
    expect(again.totals.configs.clean).toBe(1);
  });

  it('refuses to apply while a row is blocked and changes nothing', async () => {
    await seed();
    const canonical = getAgentTypeName('KeyRepairReporter');
    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO agent_configs (id, slug, context, tenant_id, agent_id, agent_class, slot_id, config_data, created_at, updated_at)
       VALUES (?, ?, '', ?, ?, ?, ?, '{}', ?, ?)`,
      'c2',
      'later-save',
      T1,
      `${T1}:${canonical}`,
      canonical,
      'sources',
      now,
      now,
    );

    await expect(
      repairTenantAgentConfigKeys(db, { apply: true }),
    ).rejects.toBeInstanceOf(TenantAgentConfigKeyRepairError);
    const rows = await db.query(
      'SELECT agent_id FROM agent_configs ORDER BY id',
    );
    expect(
      rows.rows.map((row) => (row as { agent_id: string }).agent_id),
    ).toEqual([`${T1}:KeyRepairReporter`, `${T1}:${canonical}`]);
    const binding = await db.query('SELECT agent_class FROM tenant_agents');
    expect(binding.rows[0]).toMatchObject({ agent_class: 'KeyRepairReporter' });
  });
});
