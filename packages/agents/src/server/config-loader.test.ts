/**
 * Tests for loadSlotConfigs.
 *
 * Uses vitest mocking to avoid needing a real database.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSlotConfigs } from './config-loader.js';

// Mock AgentConfig.forAgent to avoid database dependency
vi.mock('../config.js', () => ({
  AgentConfig: {
    forAgent: vi.fn(),
  },
}));

import { AgentConfig } from '../config.js';

const mockForAgent = vi.mocked(AgentConfig.forAgent);

describe('loadSlotConfigs', () => {
  const dbOptions = { db: { type: 'sqlite' as const, url: ':memory:' } };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should load slot configs for multiple agents', async () => {
    mockForAgent
      .mockResolvedValueOnce(
        new Map([
          ['sources', { scrapers: ['civicweb'] }],
          ['settings', { maxRetries: 3 }],
        ]),
      )
      .mockResolvedValueOnce(
        new Map([['forecasts', { provider: 'envcanada' }]]),
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
    mockForAgent.mockResolvedValueOnce(new Map());

    const result = await loadSlotConfigs(
      [{ id: 'agent-1', agentClass: 'Praeco' }],
      dbOptions,
    );

    expect(result['agent-1']).toBeUndefined();
  });

  it('should handle errors gracefully for individual agents', async () => {
    mockForAgent
      .mockRejectedValueOnce(new Error('table not found'))
      .mockResolvedValueOnce(new Map([['settings', { theme: 'dark' }]]));

    const result = await loadSlotConfigs(
      [
        { id: 'agent-1', agentClass: 'BrokenAgent' },
        { id: 'agent-2', agentClass: 'WorkingAgent' },
      ],
      dbOptions,
    );

    // Failed agent should not have an entry
    expect(result['agent-1']).toBeUndefined();
    // Working agent should still be loaded
    expect(result['agent-2']).toEqual({ settings: { theme: 'dark' } });
  });

  it('should return empty object for empty agents array', async () => {
    const result = await loadSlotConfigs([], dbOptions);
    expect(result).toEqual({});
    expect(mockForAgent).not.toHaveBeenCalled();
  });

  it('should pass dbOptions to AgentConfig.forAgent', async () => {
    mockForAgent.mockResolvedValueOnce(new Map());

    await loadSlotConfigs([{ id: 'agent-1', agentClass: 'Praeco' }], dbOptions);

    expect(mockForAgent).toHaveBeenCalledWith('agent-1', dbOptions);
  });
});
