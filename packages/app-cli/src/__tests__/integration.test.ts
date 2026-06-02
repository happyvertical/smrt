/**
 * End-to-end integration test: a real `@smrt()`-decorated class flows
 * through `createResourceListHandler` (server-side) → `fetchResourceList`
 * (client-side) → `buildUrl` (client-side URL construction), and we
 * assert the emitted URL matches what the SvelteKit route generator
 * would have written to disk.
 *
 * This is the test the prior rounds didn't have: every other test mocks
 * at the registry layer (server) or the network layer (client). Without
 * this, a mis-shaped `apiPath`, wrong `pathSegments`, or `parameters`
 * classification would only surface in consumer migrations. (#1311
 * review D-3 + D-4.)
 */

import { ObjectRegistry } from '@happyvertical/smrt-core';
import { createResourceListHandler } from '@happyvertical/smrt-users/sveltekit';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveAuth } from '../config.js';
import {
  type CliResource,
  fetchResourceList,
  findCommand,
  findResourceBySlug,
} from '../discovery.js';
import { buildUrl } from '../invoke.js';

/* ── helpers ──────────────────────────────────────────────────────────── */

function registerTestClass(
  name: string,
  objectDef: Record<string, unknown>,
): void {
  ObjectRegistry.registerFromManifest(name, objectDef);
}

function makeEvent() {
  return {
    cookies: { get: () => undefined },
    locals: {
      user: { id: 'u_1' },
      permissions: ['*'],
      tenantId: null,
      sessionId: 's_1',
    },
    request: new Request('https://example.test/api/_resources'),
    url: new URL('https://example.test/api/_resources'),
  };
}

/* ── shared test setup ────────────────────────────────────────────────── */

const cfgEnv = 'INTEGRATION_CLI_CONFIG';
let cfgBackup: string | undefined;

beforeEach(async () => {
  cfgBackup = process.env[cfgEnv];
  process.env[cfgEnv] = `/tmp/smrt-app-cli-integration-${Date.now()}.json`;
});

afterEach(() => {
  process.env[cfgEnv] = cfgBackup;
  vi.restoreAllMocks();
});

const cliContext = {
  envPrefix: 'INTEGRATION',
  appSlug: 'integration',
  defaultServerUrl: 'https://example.test',
};

/* ── tests ────────────────────────────────────────────────────────────── */

describe('integration: real @smrt class → handler → CLI URL', () => {
  it('end-to-end with kebabRoutes: false — dual-naming holds', async () => {
    // 1. Server side: register a class with both CRUD and a custom method
    //    (camelCase source name).
    registerTestClass('Praeco', {
      className: 'Praeco',
      collection: 'praecos',
      filePath: '/virtual/Praeco.ts',
      fields: {},
      methods: {
        discoverFromUrl: {
          name: 'discoverFromUrl',
          parameters: [{ name: 'options', type: 'object' }],
          returnType: 'Promise<any>',
          isPublic: true,
          isStatic: true,
        },
      },
      decoratorConfig: {
        api: { include: ['list', 'get', 'discoverFromUrl'] },
        cli: { mirror: 'api' },
      },
    });

    // 2. Server side: create the handler and call it.
    const handler = createResourceListHandler({
      ensureRegistry: async () => {},
      kebabRoutes: false,
    });
    const response = await handler(makeEvent());
    const body = await response.json();

    // 3. Client side: feed the body through fetchResourceList. Mock fetch
    //    to return what the handler just produced. This exercises the
    //    real type-only import boundary between the two packages.
    await saveAuth(cliContext, 'https://example.test', 'tok_abc');
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const payload = await fetchResourceList(cliContext, {
      fetch: fetchMock as any,
    });

    const resource = findResourceBySlug(payload, 'praecos');
    expect(resource).toBeDefined();
    expect((resource as CliResource).apiPath).toBe('praecos');

    // 4. Verify CRUD URL.
    const list = findCommand(resource as CliResource, 'list')!;
    expect(list.kind).toBe('crud');
    expect(list.scope).toBe('collection');
    const listUrl = await buildUrl(cliContext, resource as CliResource, list, {
      body: {},
      query: {},
      fromPositional: false,
    });
    expect(listUrl).toBe('https://example.test/api/praecos');

    // 5. Verify custom URL — `commandName` is kebab but URL keeps source casing.
    const custom = findCommand(resource as CliResource, 'discover-from-url')!;
    expect(custom).toBeDefined();
    expect(custom.commandName).toBe('discover-from-url');
    expect(custom.pathSegments).toEqual(['discoverFromUrl']);
    const customUrl = await buildUrl(
      cliContext,
      resource as CliResource,
      custom,
      { body: { url: 'https://x' }, query: {}, fromPositional: false },
    );
    expect(customUrl).toBe('https://example.test/api/praecos/discoverFromUrl');
  });

  it('end-to-end with kebabRoutes: true — surface and URL align', async () => {
    registerTestClass('Bag', {
      className: 'Bag',
      collection: 'bags',
      filePath: '/virtual/Bag.ts',
      fields: {},
      methods: {
        discoverFromUrl: {
          name: 'discoverFromUrl',
          parameters: [{ name: 'options', type: 'object' }],
          returnType: 'Promise<any>',
          isPublic: true,
          isStatic: true,
        },
      },
      decoratorConfig: {
        api: { include: ['discoverFromUrl'] },
        cli: { mirror: 'api' },
      },
    });

    const handler = createResourceListHandler({
      ensureRegistry: async () => {},
      kebabRoutes: true,
    });
    const response = await handler(makeEvent());
    const body = await response.json();

    await saveAuth(cliContext, 'https://example.test', 'tok_abc');
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const payload = await fetchResourceList(cliContext, {
      fetch: fetchMock as any,
    });

    const resource = findResourceBySlug(payload, 'bags');
    expect(resource).toBeDefined();
    const custom = findCommand(resource as CliResource, 'discover-from-url')!;
    expect(custom.commandName).toBe('discover-from-url');
    // With kebabRoutes: true, pathSegments match the command name.
    expect(custom.pathSegments).toEqual(['discover-from-url']);

    const url = await buildUrl(cliContext, resource as CliResource, custom, {
      body: {},
      query: {},
      fromPositional: false,
    });
    expect(url).toBe('https://example.test/api/bags/discover-from-url');
  });

  it('multi-word collection round-trips verbatim (regression for codex P1)', async () => {
    // tableName `weather_forecasts` previously got kebab-cased to
    // `weather-forecasts` in apiPath while the generator wrote routes at
    // `weather_forecasts/`. The CLI would 404. After the fix, both sides
    // use the same string.
    registerTestClass('WeatherForecast', {
      className: 'WeatherForecast',
      collection: 'weather_forecasts',
      filePath: '/virtual/WeatherForecast.ts',
      fields: {},
      methods: {},
      decoratorConfig: {
        api: true,
        cli: true,
        tableName: 'weather_forecasts',
      },
    });

    const handler = createResourceListHandler({
      ensureRegistry: async () => {},
    });
    const response = await handler(makeEvent());
    const body = await response.json();

    await saveAuth(cliContext, 'https://example.test', 'tok_abc');
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const payload = await fetchResourceList(cliContext, {
      fetch: fetchMock as any,
    });

    const resource = findResourceBySlug(payload, 'weather_forecasts');
    expect(resource).toBeDefined();
    expect((resource as CliResource).apiPath).toBe('weather_forecasts');
    const get = findCommand(resource as CliResource, 'get')!;
    const url = await buildUrl(
      cliContext,
      resource as CliResource,
      get,
      { body: {}, query: {}, fromPositional: false },
      'abc',
    );
    expect(url).toBe('https://example.test/api/weather_forecasts/abc');
  });
});
