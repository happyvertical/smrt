/**
 * Tests for `invokeCommand` URL/method/body matrix. Mocks fetch + config
 * to avoid disk and network.
 */

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveAuth } from '../config.js';
import type { CliResource, CommandDefinition } from '../discovery.js';
import { buildUrl, invokeCommand } from '../invoke.js';
import type { ParsedArgs } from '../parser.js';

function makeContext() {
  const slug = `app-cli-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  // The config helper keys the config-file path off `${envPrefix}_CLI_CONFIG`
  // (here `TEST_CLI_CONFIG`), NOT off a `TEST_CONFIG_DIR` var. Setting the
  // wrong var meant these tests wrote to the real `~/.config/test-cli/
  // config.json` and never cleaned up. Point the override at a tmp file
  // so each context is isolated and disposable. (#1311 PR review.)
  process.env.TEST_CLI_CONFIG = join(
    tmpdir(),
    'smrt-app-cli-tests',
    slug,
    'config.json',
  );
  return {
    envPrefix: 'TEST',
    appSlug: 'test-cli',
    defaultServerUrl: 'https://example.test',
  };
}

const noQuery: ParsedArgs = { body: {}, query: {}, fromPositional: false };
const withBody = (body: Record<string, unknown>): ParsedArgs => ({
  body,
  query: {},
  fromPositional: false,
});
const withQuery = (query: Record<string, string | string[]>): ParsedArgs => ({
  body: {},
  query,
  fromPositional: false,
});

function makeResource(): CliResource {
  return {
    slug: 'praecos',
    className: 'Praeco',
    label: 'Praecos',
    apiPath: 'praecos',
    commands: [],
  };
}

function makeCommand(over: Partial<CommandDefinition>): CommandDefinition {
  return {
    methodName: 'list',
    commandName: 'list',
    kind: 'crud',
    scope: 'collection',
    httpMethod: 'GET',
    pathSegments: [],
    ...over,
  };
}

describe('buildUrl', () => {
  const context = makeContext();
  const resource = makeResource();

  it('CRUD list (collection GET)', async () => {
    const url = await buildUrl(
      context,
      resource,
      makeCommand({}),
      withQuery({ limit: '5' }),
    );
    expect(url).toBe('https://example.test/api/praecos?limit=5');
  });

  it('CRUD get (item GET)', async () => {
    const url = await buildUrl(
      context,
      resource,
      makeCommand({
        methodName: 'get',
        commandName: 'get',
        scope: 'item',
      }),
      noQuery,
      'abc',
    );
    expect(url).toBe('https://example.test/api/praecos/abc');
  });

  it('CRUD create (collection POST)', async () => {
    const url = await buildUrl(
      context,
      resource,
      makeCommand({
        methodName: 'create',
        commandName: 'create',
        httpMethod: 'POST',
      }),
      withBody({ x: 1 }),
    );
    expect(url).toBe('https://example.test/api/praecos');
  });

  it('CRUD update (item PUT)', async () => {
    const url = await buildUrl(
      context,
      resource,
      makeCommand({
        methodName: 'update',
        commandName: 'update',
        scope: 'item',
        httpMethod: 'PUT',
      }),
      withBody({ x: 1 }),
      'abc',
    );
    expect(url).toBe('https://example.test/api/praecos/abc');
  });

  it('CRUD delete (item DELETE)', async () => {
    const url = await buildUrl(
      context,
      resource,
      makeCommand({
        methodName: 'delete',
        commandName: 'delete',
        scope: 'item',
        httpMethod: 'DELETE',
      }),
      noQuery,
      'abc',
    );
    expect(url).toBe('https://example.test/api/praecos/abc');
  });

  it('custom item POST', async () => {
    const url = await buildUrl(
      context,
      resource,
      makeCommand({
        kind: 'custom',
        methodName: 'discover',
        commandName: 'discover',
        scope: 'item',
        httpMethod: 'POST',
        pathSegments: ['discover'],
      }),
      withBody({ limit: 5 }),
      'abc',
    );
    expect(url).toBe('https://example.test/api/praecos/abc/discover');
  });

  it('custom collection POST', async () => {
    const url = await buildUrl(
      context,
      resource,
      makeCommand({
        kind: 'custom',
        methodName: 'discoverFromUrl',
        commandName: 'discover-from-url',
        scope: 'collection',
        httpMethod: 'POST',
        pathSegments: ['discoverFromUrl'],
      }),
      withBody({ url: 'https://x' }),
    );
    expect(url).toBe('https://example.test/api/praecos/discoverFromUrl');
  });

  it('custom kebab-segment when kebabRoutes was on at gen-time', async () => {
    const url = await buildUrl(
      context,
      resource,
      makeCommand({
        kind: 'custom',
        methodName: 'discoverFromUrl',
        commandName: 'discover-from-url',
        scope: 'collection',
        httpMethod: 'POST',
        pathSegments: ['discover-from-url'],
      }),
      withBody({ url: 'https://x' }),
    );
    expect(url).toBe('https://example.test/api/praecos/discover-from-url');
  });

  it('custom GET routes flag-parsed params to query string', async () => {
    const url = await buildUrl(
      context,
      resource,
      makeCommand({
        kind: 'custom',
        methodName: 'facts',
        commandName: 'facts',
        scope: 'collection',
        httpMethod: 'GET',
        pathSegments: ['facts'],
      }),
      withQuery({ limit: '10' }),
    );
    expect(url).toBe('https://example.test/api/praecos/facts?limit=10');
  });

  it('encodes id with URI-safe escaping', async () => {
    const url = await buildUrl(
      context,
      resource,
      makeCommand({
        methodName: 'get',
        commandName: 'get',
        scope: 'item',
      }),
      noQuery,
      'a b/c',
    );
    expect(url).toBe('https://example.test/api/praecos/a%20b%2Fc');
  });

  it('strips leading/trailing slashes from apiPath and encodes pieces — #1311 A2/C3', async () => {
    const url = await buildUrl(
      context,
      { ...resource, apiPath: '/v1/items/' },
      makeCommand({}),
      noQuery,
    );
    expect(url).toBe('https://example.test/api/v1/items');
  });

  it('URL-encodes special characters in path segments — #1311 A2', async () => {
    const url = await buildUrl(
      context,
      resource,
      makeCommand({
        kind: 'custom',
        methodName: 'special',
        commandName: 'special',
        scope: 'collection',
        httpMethod: 'POST',
        pathSegments: ['needs space'],
      }),
      withBody({}),
    );
    expect(url).toBe('https://example.test/api/praecos/needs%20space');
  });

  it('rejects path traversal in pathSegments by encoding the segment — #1311 A2', async () => {
    const url = await buildUrl(
      context,
      resource,
      makeCommand({
        kind: 'custom',
        methodName: 'evil',
        commandName: 'evil',
        scope: 'collection',
        httpMethod: 'POST',
        pathSegments: ['..%2Fadmin'],
      }),
      withBody({}),
    );
    // `..%2Fadmin` is percent-encoded again, so the literal segment is
    // preserved and cannot escape the path.
    expect(url).toBe('https://example.test/api/praecos/..%252Fadmin');
  });

  it('errors when item-scope command is called without id', async () => {
    await expect(
      buildUrl(
        context,
        resource,
        makeCommand({ scope: 'item' }),
        noQuery,
        undefined,
      ),
    ).rejects.toThrow(/id positional/);
  });
});

describe('invokeCommand', () => {
  const context = makeContext();
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    await saveAuth(context, 'https://example.test', 'tok_abc');
    fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Response('{"ok":true}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
  });

  afterEach(() => {
    delete process.env.TEST_TOKEN;
  });

  it('sends Authorization header and JSON body for POST', async () => {
    await invokeCommand({
      context,
      resource: makeResource(),
      command: makeCommand({
        kind: 'custom',
        methodName: 'discover',
        commandName: 'discover',
        scope: 'item',
        httpMethod: 'POST',
        pathSegments: ['discover'],
      }),
      parsed: withBody({ limit: 5 }),
      id: 'abc',
      fetch: fetchMock as any,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://example.test/api/praecos/abc/discover');
    expect(init.method).toBe('POST');
    expect((init.headers as Headers).get('authorization')).toBe(
      'Bearer tok_abc',
    );
    expect((init.headers as Headers).get('content-type')).toBe(
      'application/json',
    );
    expect(init.body).toBe('{"limit":5}');
  });

  it('omits body and content-type for GET', async () => {
    await invokeCommand({
      context,
      resource: makeResource(),
      command: makeCommand({}),
      parsed: withQuery({ limit: '10' }),
      fetch: fetchMock as any,
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect((init.headers as Headers).get('content-type')).toBeNull();
  });

  it('omits body for DELETE', async () => {
    await invokeCommand({
      context,
      resource: makeResource(),
      command: makeCommand({
        methodName: 'delete',
        commandName: 'delete',
        scope: 'item',
        httpMethod: 'DELETE',
      }),
      parsed: noQuery,
      id: 'abc',
      fetch: fetchMock as any,
    });
    const [, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe('DELETE');
    expect(init.body).toBeUndefined();
  });

  it('omits Authorization header when no token is stored — #1311 reviewer B test gap', async () => {
    // Fresh context with no auth stored.
    const freshSlug = `app-cli-noauth-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const freshDir = join(tmpdir(), 'smrt-app-cli-tests', freshSlug);
    const envKey = 'NOTOK_CLI_CONFIG';
    process.env[envKey] = join(freshDir, 'config.json');
    const freshContext = {
      envPrefix: 'NOTOK',
      appSlug: 'notok',
      defaultServerUrl: 'https://example.test',
    };

    await invokeCommand({
      context: freshContext,
      resource: makeResource(),
      command: makeCommand({}),
      parsed: noQuery,
      fetch: fetchMock as any,
    });
    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Headers).get('authorization')).toBeNull();

    delete process.env[envKey];
  });
});
