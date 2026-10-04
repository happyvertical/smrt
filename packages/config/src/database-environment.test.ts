/**
 * `resolveCliDatabaseConfig()` — the CLI database precedence that `smrt` and
 * `smrt-dev-mcp` share (#3410, #3446).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { clearCache, resolveCliDatabaseConfig, setConfig } from './index.js';

const PASSWORD = 'pg-password-must-never-print';

afterEach(() => {
  clearCache();
});

describe('resolveCliDatabaseConfig', () => {
  it('uses DATABASE_URL when no config layer names a database', () => {
    expect(
      resolveCliDatabaseConfig({
        DATABASE_URL: ' /data/app.sqlite ',
        DATABASE_TYPE: 'sqlite',
      }),
    ).toEqual({
      source: 'environment',
      database: { type: 'sqlite', url: '/data/app.sqlite' },
    });
  });

  it.each([
    ['postgres://u@db.example/app', undefined, 'postgres'],
    ['postgresql://u@db.example/app', undefined, 'postgres'],
    ['./dev.db', undefined, 'sqlite'],
    ['postgres://u@db.example/app', 'PostgreSQL', 'postgres'],
  ])('derives the engine for %s (DATABASE_TYPE %s)', (url, type, expected) => {
    expect(
      resolveCliDatabaseConfig({ DATABASE_URL: url, DATABASE_TYPE: type })
        .database,
    ).toEqual({ type: expected, url });
  });

  it('lets a configured URL win without reading the environment', () => {
    setConfig({
      packages: { cli: { database: { type: 'sqlite', url: './dev.db' } } },
    } as never);
    expect(
      resolveCliDatabaseConfig({
        DATABASE_URL: 'postgres://u@elsewhere/app',
        DATABASE_TYPE: 'not-an-engine',
      }),
    ).toEqual({
      source: 'config',
      database: { type: 'sqlite', url: './dev.db' },
    });
  });

  it('reports a typeless configured URL without inventing an engine', () => {
    setConfig({
      packages: { cli: { database: { url: './dev.db' } } },
    } as never);
    expect(resolveCliDatabaseConfig({})).toEqual({
      source: 'config',
      database: { url: './dev.db' },
    });
  });

  it('pairs an environment URL with a configured engine', () => {
    setConfig({
      packages: { cli: { database: { type: 'postgres' } } },
    } as never);
    expect(
      resolveCliDatabaseConfig({
        DATABASE_URL: 'postgres://u@db.example/app',
        DATABASE_TYPE: 'sqlite',
      }).database,
    ).toEqual({ type: 'postgres', url: 'postgres://u@db.example/app' });
  });

  it('is none for an empty URL and refuses an unknown engine without the URL', () => {
    expect(resolveCliDatabaseConfig({ DATABASE_URL: '  ' })).toEqual({
      source: 'none',
      database: null,
    });
    const refused = resolveCliDatabaseConfig({
      DATABASE_URL: `mysql://root:${PASSWORD}@db/app`,
      DATABASE_TYPE: 'mysql',
    });
    expect(refused).toMatchObject({
      source: 'invalid-environment',
      database: null,
    });
    expect(refused.error).toContain('DATABASE_TYPE');
    expect(JSON.stringify(refused)).not.toContain(PASSWORD);
  });

  it('never writes the resolved database into the config', () => {
    resolveCliDatabaseConfig({ DATABASE_URL: '/data/app.sqlite' });
    expect(resolveCliDatabaseConfig({})).toEqual({
      source: 'none',
      database: null,
    });
  });
});
