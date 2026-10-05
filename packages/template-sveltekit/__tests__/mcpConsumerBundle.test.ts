/**
 * A production-bundled app that consumes smrt-chat serves its `/mcp` route
 * (#3490).
 *
 * `mountMcpAppRoute({ models: [Note] })` in an app whose `consumer.packages`
 * include `@happyvertical/smrt-chat` answered every `tools/list` and
 * `tools/call` with `Duplicate MCP tool name: agentconfig_list`: the server
 * build inlined smrt-agents, its `AgentConfig` registered under the app's
 * package before smrt-agents' manifest registered, and core generated tools
 * for every registered class before the route applied its allow-list. Package
 * suites never saw it — they register only their own models and run
 * unbundled.
 *
 * This builds `fixtures/mcp-chat-consumer/server.ts` with Vite's SSR build into
 * a throwaway app directory (chat and smrt-agents inlined, as SvelteKit
 * inlines Svelte libraries), then loads the output in a plain Node process
 * and posts MCP requests to the built handler.
 */
import { execFile } from 'node:child_process';
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build, type Plugin } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureEntry = join(packageRoot, 'fixtures/mcp-chat-consumer/server.ts');

/** Runs in the child process against the built server entry. */
const RUNNER = `
import { pathToFileURL } from 'node:url';
const entry = await import(pathToFileURL(process.argv[2]).href);
const { ObjectRegistry } = await import('@happyvertical/smrt-core');
// Reported rather than thrown, so a failure still shows what the route says.
const setupError = await entry.setup().then(
  () => null,
  (error) => String(error?.message ?? error),
);
const meta = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'lane-3490', version: '0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};
const owner = {
  user: { id: 'owner-1' },
  tenantId: 'tenant-a',
  permissions: ['notes.read'],
  sessionId: 'sid-1',
};
async function send(method, params, locals) {
  const url = new URL('http://127.0.0.1/mcp');
  const response = await entry.POST({
    locals,
    url,
    request: new Request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': method,
        ...(params.name ? { 'mcp-name': params.name } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: { ...params, _meta: meta },
      }),
    }),
  });
  return { status: response.status, body: await response.json() };
}
const agentConfig = [...ObjectRegistry.getAllClasses()]
  .filter(([, info]) => info.name === 'AgentConfig')
  .map(([key, info]) => ({
    key,
    stub: info.constructor._isManifestStub === true,
  }));
const keysByName = new Map();
for (const [key, info] of ObjectRegistry.getAllClasses()) {
  keysByName.set(info.name, [...(keysByName.get(info.name) ?? []), key]);
}
console.log(JSON.stringify({
  setupError,
  chatExportCount: entry.chatExportCount,
  agentConfig,
  duplicates: [...keysByName.values()].filter((keys) => keys.length > 1),
  appOwned: [...ObjectRegistry.getAllClasses().keys()].filter((key) =>
    key.startsWith('@fixture/'),
  ),
  ownerList: await send('tools/list', {}, owner),
  anonymousList: await send('tools/list', {}, {}),
  noteList: await send(
    'tools/call',
    { name: 'note_list', arguments: {} },
    owner,
  ),
}));
`;

/**
 * SvelteKit inlines Svelte libraries into the server output; both ship Svelte
 * subpaths, and smrt-agents' `AgentConfig` lives in a shared chunk its index
 * imports before its own manifest registration.
 */
const INLINED = ['@happyvertical/smrt-chat', '@happyvertical/smrt-agents'];

/**
 * Inline `packages`; leave every other package import external, pinned to the
 * file it resolves to now. The workspace's strict layout gives no single
 * directory from which every transitive import resolves at run time.
 */
function inlineOnly(packages: readonly string[]): Plugin {
  const inlined = (source: string) =>
    packages.some((name) => source === name || source.startsWith(`${name}/`));
  return {
    name: 'smrt-3490-inline-only',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (
        !importer ||
        inlined(source) ||
        /^(?:[./\0]|node:|[a-z]+:)/i.test(source)
      ) {
        return null;
      }
      const resolved = await this.resolve(source, importer, {
        ...options,
        skipSelf: true,
      });
      if (!resolved || resolved.external) return resolved;
      return { id: resolved.id, external: true };
    },
  };
}

interface RunResult {
  setupError: string | null;
  chatExportCount: number;
  agentConfig: Array<{ key: string; stub: boolean }>;
  duplicates: string[][];
  appOwned: string[];
  ownerList: { status: number; body: Record<string, any> };
  anonymousList: { status: number; body: Record<string, any> };
  noteList: { status: number; body: Record<string, any> };
}

describe('MCP route in a production bundle that consumes smrt-chat (#3490)', () => {
  let appRoot: string;
  let result: RunResult;

  beforeAll(async () => {
    appRoot = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-3490-app-')));
    writeFileSync(
      join(appRoot, 'package.json'),
      JSON.stringify({
        name: '@fixture/chat-mcp-consumer',
        private: true,
        type: 'module',
      }),
    );
    // The runner resolves `@happyvertical/smrt-core` from the app, as the
    // built server's own external imports do.
    symlinkSync(join(packageRoot, 'node_modules'), join(appRoot, 'node_modules'));
    const outDir = join(appRoot, 'build/server');
    await build({
      root: appRoot,
      configFile: false,
      logLevel: 'silent',
      oxc: { decorator: { legacy: true, emitDecoratorMetadata: true } },
      plugins: [inlineOnly(INLINED)],
      build: {
        ssr: fixtureEntry,
        outDir,
        emptyOutDir: true,
        minify: false,
        rolldownOptions: { output: { entryFileNames: 'server.js' } },
      },
    });
    writeFileSync(join(appRoot, 'runner.mjs'), RUNNER);
    const { stdout } = await exec(
      process.execPath,
      [join(appRoot, 'runner.mjs'), join(outDir, 'server.js')],
      { cwd: appRoot, maxBuffer: 16 * 1024 * 1024, env: { ...process.env } },
    );
    const line = stdout.trim().split('\n').at(-1) ?? '';
    result = JSON.parse(line) as RunResult;
  }, 240_000);

  afterAll(() => {
    if (appRoot) rmSync(appRoot, { recursive: true, force: true });
  });

  it('bundles the consumed package and registers its AgentConfig once, under smrt-agents', () => {
    expect(result.chatExportCount).toBeGreaterThan(0);
    expect(result.setupError).toBeNull();
    expect(result.agentConfig).toEqual([
      { key: '@happyvertical/smrt-agents:AgentConfig', stub: false },
    ]);
  });

  it("registers every inlined dependency class once, and only the app's own model under the app", () => {
    expect(result.duplicates).toEqual([]);
    expect(result.appOwned).toEqual(['@fixture/chat-mcp-consumer:Note']);
  });

  it('lists exactly the allow-listed model for the owner', () => {
    expect(result.ownerList.status).toBe(200);
    expect(result.ownerList.body.error).toBeUndefined();
    expect(
      (result.ownerList.body.result.tools as Array<{ name: string }>).map(
        ({ name }) => name,
      ),
    ).toEqual(['note_get', 'note_list']);
  });

  it('lists nothing for an anonymous caller, without an error', () => {
    expect(result.anonymousList.status).toBe(200);
    expect(result.anonymousList.body.error).toBeUndefined();
    expect(result.anonymousList.body.result.tools).toEqual([]);
  });

  it('serves note_list through the route', () => {
    expect(result.noteList.status).toBe(200);
    expect(result.noteList.body.error).toBeUndefined();
    expect(result.noteList.body.result.isError).not.toBe(true);
    expect(JSON.stringify(result.noteList.body.result)).toContain(
      'bundled note',
    );
  });
});
