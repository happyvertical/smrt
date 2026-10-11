import { describe, expect, it } from 'vitest';
import {
  normalizeAppBasePath,
  normalizePlannerAppConfig,
} from '../src/lib/core/app.ts';

describe('hosted app materialization contract', () => {
  it('accepts a canonical prefix and normalizes the hosted policy', () => {
    expect(normalizeAppBasePath('/plan')).toBe('/plan');
    expect(
      normalizePlannerAppConfig({
        inference: {
          mode: 'byo',
          alternatives: ['browser'],
          credentialPersistence: 'memory',
          byo: {
            presets: ['ollama', 'openrouter', 'openai', 'custom'],
          },
        },
      }),
    ).toEqual({
      inference: {
        mode: 'byo',
        alternatives: ['browser'],
        credentialPersistence: 'memory',
        byo: { presets: ['ollama', 'openrouter', 'openai', 'custom'] },
      },
    });
  });

  it.each([
    'plan',
    '/plan/',
    '/',
    '/plan?x',
    '/plan//nested',
    '/plan/.',
    '/plan/../nested',
    '/plan/nested/..',
    '/plan/%2e%2e',
  ])('rejects a non-canonical base: %s', (basePath) =>
    expect(() => normalizeAppBasePath(basePath)).toThrow());

  it('rejects malformed configs and every credential-shaped field', () => {
    expect(() =>
      normalizePlannerAppConfig({
        inference: { mode: 'byo', alternatives: ['byo'] },
      }),
    ).toThrow(/inference is off/);
    expect(() =>
      normalizePlannerAppConfig({
        inference: {
          mode: 'byo',
          byo: {
            presets: [
              {
                id: 'unsafe',
                label: 'Unsafe',
                baseUrl: 'https://models.example/v1',
                apiKey: 'must-not-ship',
              } as never,
            ],
          },
        },
      }),
    ).toThrow(/credential field/);
    expect(() =>
      normalizePlannerAppConfig({
        inference: {
          mode: 'byo',
          byo: {
            presets: [
              {
                id: 'unsafe',
                label: 'Unsafe',
                baseUrl: 'https://models.example/v1?token=must-not-ship',
              },
            ],
          },
        },
      }),
    ).toThrow(/inference is off/);
    expect(() =>
      normalizePlannerAppConfig({
        inference: {
          mode: 'byo',
          byo: {
            presets: [
              {
                id: 'unsafe',
                label: 'Unsafe',
                baseUrl: 'https://models.example/v1#api_key=must-not-ship',
              },
            ],
          },
        },
      }),
    ).toThrow(/inference is off/);
    expect(() =>
      normalizePlannerAppConfig({
        inference: {
          mode: 'host',
          host: { endpoint: '/api/planner/chat#token=must-not-ship' },
        },
      }),
    ).toThrow(/inference is off/);
    expect(() =>
      normalizePlannerAppConfig({
        kitchen: { endpoint: '/kitchen?token=must-not-ship' },
      }),
    ).toThrow(/kitchen.endpoint/);
    expect(() =>
      normalizePlannerAppConfig({
        kitchen: { endpoint: '/kitchen#token=must-not-ship' },
      }),
    ).toThrow(/kitchen.endpoint/);
  });
});
