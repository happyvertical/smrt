/**
 * Tests for loadSlotConfigs.
 *
 * Uses vitest mocking to avoid needing a real database.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSlotConfigs } from './config-loader.js';

// Mock AgentConfig.forAgents to avoid database dependency
vi.mock('../config.js', () => ({
  AgentConfig: {
    forAgents: vi.fn(),
  },
}));

import { AgentConfig } from '../config.js';

const mockForAgents = vi.mocked(AgentConfig.forAgents);

describe('loadSlotConfigs', () => {
  const dbOptions = { db: { type: 'sqlite' as const, url: ':memory:' } };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should load slot configs for multiple agents', async () => {
    mockForAgents.mockResolvedValueOnce(
      new Map([
        [
          'agent-1',
          new Map([
            ['sources', { scrapers: ['civicweb'] }],
            ['settings', { maxRetries: 3 }],
          ]),
        ],
        ['agent-2', new Map([['forecasts', { provider: 'envcanada' }]])],
      ]),
    );

    const result = await loadSlotConfigs(
      [
        { id: 'agent-1', agentClass: 'Praeco' },
        { id: 'agent-2', agentClass: 'Caelus' },
      ],
      dbOptions,
    );

    expect(result['agent-1']).toEqual({
      sources: { scrapers: ['civicweb'] },
      settings: { maxRetries: 3 },
    });
    expect(result['agent-2']).toEqual({
      forecasts: { provider: 'envcanada' },
    });
  });

  it('should skip agents with no slot configs', async () => {
    mockForAgents.mockResolvedValueOnce(new Map());

    const result = await loadSlotConfigs(
      [{ id: 'agent-1', agentClass: 'Praeco' }],
      dbOptions,
    );

    expect(result['agent-1']).toBeUndefined();
  });

  it('should return an empty object when the agent_configs table is missing', async () => {
    mockForAgents.mockRejectedValueOnce(
      new Error(
        "Table 'agent_configs' does not exist for class 'AgentConfig'. Run 'smrt db:migrate' to create database schema.",
      ),
    );

    const result = await loadSlotConfigs(
      [
        { id: 'agent-1', agentClass: 'BrokenAgent' },
        { id: 'agent-2', agentClass: 'WorkingAgent' },
      ],
      dbOptions,
    );

    expect(result).toEqual({});
  });

  it('should rethrow unexpected config-loading errors', async () => {
    mockForAgents.mockRejectedValueOnce(new Error('database connection lost'));

    await expect(
      loadSlotConfigs(
        [{ id: 'agent-1', agentClass: 'BrokenAgent' }],
        dbOptions,
      ),
    ).rejects.toThrow('database connection lost');
  });

  it('should rethrow unrelated missing-table errors', async () => {
    mockForAgents.mockRejectedValueOnce(
      new Error('relation "dispatch_subscriptions" does not exist'),
    );

    await expect(
      loadSlotConfigs(
        [{ id: 'agent-1', agentClass: 'BrokenAgent' }],
        dbOptions,
      ),
    ).rejects.toThrow('dispatch_subscriptions');
  });

  it('should return empty object for empty agents array', async () => {
    const result = await loadSlotConfigs([], dbOptions);
    expect(result).toEqual({});
    expect(mockForAgents).not.toHaveBeenCalled();
  });

  it('should pass agent IDs and dbOptions to AgentConfig.forAgents', async () => {
    mockForAgents.mockResolvedValueOnce(new Map());

    await loadSlotConfigs([{ id: 'agent-1', agentClass: 'Praeco' }], dbOptions);

    expect(mockForAgents).toHaveBeenCalledWith(['agent-1'], dbOptions);
  });
});
