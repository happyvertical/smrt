/**
 * Tests for `fetchResourceList` — auth states + lookups.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type CliConfigContext, saveAuth } from '../config.js';
import {
  fetchResourceList,
  findCommand,
  findResourceBySlug,
} from '../discovery.js';

let context: CliConfigContext;
let cfgBackup: string | undefined;

beforeEach(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'smrt-app-cli-discovery-'));
  cfgBackup = process.env.DISCO_CLI_CONFIG;
  process.env.DISCO_CLI_CONFIG = join(dir, 'config.json');
  context = {
    envPrefix: 'DISCO',
    appSlug: 'disco',
    defaultServerUrl: 'https://server.example',
  };
});

afterEach(async () => {
  if (process.env.DISCO_CLI_CONFIG) {
    await rm(process.env.DISCO_CLI_CONFIG, { force: true }).catch(() => {});
  }
  process.env.DISCO_CLI_CONFIG = cfgBackup;
});

describe('fetchResourceList', () => {
  it('returns parsed payload on 200', async () => {
    await saveAuth(context, 'https://server.example', 'tok');
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            user: { authenticated: true, id: 'u1' },
            warnings: [],
            resources: [
              {
                slug: 'praecos',
                className: 'Praeco',
                label: 'Praecos',
                apiPath: 'praecos',
                commands: [],
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    const r = await fetchResourceList(context, { fetch: fetchMock as any });
    expect(r.resources[0]?.slug).toBe('praecos');
  });

  it('translates 401 into a friendly "log in" error', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('{"error":"401 unauthenticated"}', {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(
      fetchResourceList(context, { fetch: fetchMock as any }),
    ).rejects.toThrow(/auth login/);
  });
});

describe('findResourceBySlug / findCommand', () => {
  const payload = {
    user: { authenticated: true },
    warnings: [],
    resources: [
      {
        slug: 'praecos',
        className: 'Praeco',
        label: 'Praecos',
        apiPath: 'praecos',
        commands: [
          {
            methodName: 'list',
            commandName: 'list',
            kind: 'crud' as const,
            scope: 'collection' as const,
            httpMethod: 'GET' as const,
            pathSegments: [],
          },
          {
            methodName: 'discover',
            commandName: 'discover',
            kind: 'custom' as const,
            scope: 'item' as const,
            httpMethod: 'POST' as const,
            pathSegments: ['discover'],
          },
        ],
      },
    ],
  };

  it('finds resource by slug', () => {
    expect(findResourceBySlug(payload, 'praecos')?.className).toBe('Praeco');
    expect(findResourceBySlug(payload, 'others')).toBeUndefined();
  });

  it('finds command by name', () => {
    const r = findResourceBySlug(payload, 'praecos')!;
    expect(findCommand(r, 'discover')?.methodName).toBe('discover');
    expect(findCommand(r, 'bogus')).toBeUndefined();
  });
});
