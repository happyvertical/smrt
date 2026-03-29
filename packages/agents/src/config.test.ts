import { afterEach, describe, expect, it, vi } from 'vitest';

async function loadFreshAgentsModules() {
  vi.resetModules();
  const core = await import('@happyvertical/smrt-core');
  const agents = await import('./index.js');
  return { ...core, ...agents };
}

afterEach(async () => {
  const { ObjectRegistry } = await import('@happyvertical/smrt-core');
  ObjectRegistry.clear();
});

describe('agent model runtime field registration', () => {
  it('supports AgentConfig slot lookups when loaded directly from source', async () => {
    const { getTestDatabase, ObjectRegistry, AgentConfig } =
      await loadFreshAgentsModules();
    const db = await getTestDatabase();

    await AgentConfig.saveSlot(
      {
        agentId: 'praeco-main',
        agentClass: 'Praeco',
        slotId: 'sources',
        configData: { scrapers: ['civicweb'] },
      },
      { db },
    );

    const fields = await ObjectRegistry.getAllFields('AgentConfig');
    expect(fields.has('agentId')).toBe(true);
    expect(fields.has('agentClass')).toBe(true);
    expect(fields.has('slotId')).toBe(true);
    expect(fields.get('configData')?.type).toBe('json');
    expect(fields.get('schemaVersion')?.type).toBe('integer');

    const configs = await AgentConfig.forAgent('praeco-main', { db });
    expect(configs.get('sources')).toEqual({ scrapers: ['civicweb'] });

    const slotConfig = await AgentConfig.forSlot('praeco-main', 'sources', {
      db,
    });
    expect(slotConfig).toEqual({ scrapers: ['civicweb'] });
  });

  it('registers AgentSchedule fields with explicit runtime types', async () => {
    const { ObjectRegistry } = await loadFreshAgentsModules();
    await import('./schedule.js');

    const fields = await ObjectRegistry.getAllFields('AgentSchedule');
    expect(fields.get('agentType')?.type).toBe('text');
    expect(fields.get('agentConfig')?.type).toBe('json');
    expect(fields.get('enabled')?.type).toBe('boolean');
    expect(fields.get('nextRun')?.type).toBe('datetime');
    expect(fields.get('runningCount')?.type).toBe('integer');
  });

  it('registers TenantAgent JSON and text fields when loaded directly', async () => {
    const { ObjectRegistry } = await loadFreshAgentsModules();
    await import('./tenant-agent.js');

    const fields = await ObjectRegistry.getAllFields('TenantAgent');
    expect(fields.get('agentClass')?.type).toBe('text');
    expect(fields.get('status')?.type).toBe('text');
    expect(fields.get('permissions')?.type).toBe('json');
    expect(fields.get('config')?.type).toBe('json');
  });
});
