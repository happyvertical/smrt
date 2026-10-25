import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  SERVER_INFO_META_KEY,
} from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const conformanceBin = join(packageRoot, 'node_modules', '.bin', 'conformance');
const baselinePath = join(packageRoot, 'conformance-baseline.yml');
const require = createRequire(import.meta.url);
const children = new Set<ChildProcess>();
let fixtureRoot: string;
let mcpUrl: string;

beforeAll(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'smrt-dev-mcp-conformance-'));
  await writeFile(
    join(fixtureRoot, 'package.json'),
    JSON.stringify({ name: 'conformance-consumer', private: true }),
  );
  await writeFile(
    join(fixtureRoot, 'pnpm-workspace.yaml'),
    "packages:\n  - 'packages/*'\n",
  );
  await writeFixturePackage('catalog', 'Product');

  // Isolate cwd in a child: production discovery uses process.cwd(). The
  // consumer has its own workspace and no link to the monorepo's node_modules.
  const child = spawn(
    process.execPath,
    [
      '--import',
      pathToFileURL(require.resolve('tsx/esm')).href,
      join(packageRoot, 'test-support', 'conformance-http.mjs'),
    ],
    { cwd: fixtureRoot, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  children.add(child);
  let output = '';
  child.stdout?.on('data', (chunk) => {
    output += String(chunk);
  });
  child.stderr?.on('data', (chunk) => {
    output += String(chunk);
  });
  mcpUrl = await new Promise<string>((resolveReady, rejectReady) => {
    const timer = setTimeout(() => {
      cleanup();
      rejectReady(new Error(`Conformance host did not start: ${output}`));
    }, 20_000);
    const onError = (error: Error) => {
      cleanup();
      rejectReady(error);
    };
    const onExit = (code: number | null) => {
      cleanup();
      rejectReady(new Error(`Conformance host exited (${code}): ${output}`));
    };
    const onMessage = (message: unknown) => {
      if (
        typeof message === 'object' &&
        message &&
        'url' in message &&
        typeof message.url === 'string'
      ) {
        cleanup();
        resolveReady(message.url);
      }
    };
    function cleanup() {
      clearTimeout(timer);
      child.off('error', onError);
      child.off('exit', onExit);
      child.off('message', onMessage);
    }
    child.once('error', onError);
    child.once('exit', onExit);
    child.on('message', onMessage);
  });
});

afterAll(async () => {
  try {
    await Promise.all([...children].map(stopChild));
  } finally {
    if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  }
});

describe('smrt-dev-mcp MCP 2026-07-28 conformance', () => {
  it('answers discover and stamps complete results from per-request metadata', async () => {
    const discover = await modernRequest('server/discover');
    expect(discover.status).toBe(200);
    expect(discover.body.result).toMatchObject({
      supportedVersions: ['2026-07-28'],
      resultType: 'complete',
      _meta: { [SERVER_INFO_META_KEY]: { name: 'smrt-dev-mcp' } },
    });
    const list = await modernRequest('tools/list');
    expect(list.body.result).toMatchObject({
      resultType: 'complete',
      ttlMs: 86_400_000,
      cacheScope: 'private',
    });

    const prompts = await modernRequest('prompts/list');
    expect(prompts.body.result).toMatchObject({
      ttlMs: 86_400_000,
      cacheScope: 'private',
    });

    const resources = await modernRequest('resources/list');
    expect(resources.body.result).toMatchObject({
      ttlMs: 0,
      cacheScope: 'private',
    });

    const read = await modernRequest('resources/read', 'resources/read', {
      uri: 'smrt-dev-mcp://agent-skills/smrt-code-review',
    });
    expect(read.body.result).toMatchObject({
      ttlMs: 0,
      cacheScope: 'private',
    });

    const mismatch = await modernRequest('tools/list', 'server/discover');
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error.code).toBe(-32020);
  });

  it('discovers consumer models and docs and refreshes resources after edits', async () => {
    const catalogUri = packageUri('catalog');
    const initialList = await modernRequest('resources/list');
    expect(initialList.body.result.resources).toEqual(
      expect.arrayContaining([expect.objectContaining({ uri: catalogUri })]),
    );
    expect(
      initialList.body.result.resources
        .map((resource: { uri: string }) => resource.uri)
        .filter((uri: string) => uri.startsWith('smrt://knowledge/package/'))
        .sort(),
    ).toEqual(
      [
        packageUri('catalog'),
        'smrt://knowledge/package/conformance-consumer',
      ].sort(),
    );
    const initialRead = await modernRequest(
      'resources/read',
      'resources/read',
      {
        uri: catalogUri,
      },
    );
    expect(JSON.parse(initialRead.body.result.contents[0].text)).toMatchObject({
      name: '@conformance/catalog',
      objectSource: 'manifest',
      agentDoc: '# catalog\n\nConsumer model documentation.\n',
      objects: [
        expect.objectContaining({
          className: 'Product',
          fields: [expect.objectContaining({ name: 'title', type: 'text' })],
        }),
      ],
    });

    await writeFixturePackage('orders', 'Order');
    const revisedDocs = '# catalog\n\nUpdated consumer model documentation.\n';
    await writeFile(
      join(fixtureRoot, 'packages', 'catalog', 'AGENTS.md'),
      revisedDocs,
    );
    const refreshedList = await modernRequest('resources/list');
    expect(refreshedList.body.result).toMatchObject({
      ttlMs: 0,
      cacheScope: 'private',
    });
    expect(refreshedList.body.result.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ uri: catalogUri }),
        expect.objectContaining({ uri: packageUri('orders') }),
      ]),
    );
    const refreshedRead = await modernRequest(
      'resources/read',
      'resources/read',
      {
        uri: catalogUri,
      },
    );
    expect(refreshedRead.body.result).toMatchObject({
      ttlMs: 0,
      cacheScope: 'private',
    });
    expect(
      JSON.parse(refreshedRead.body.result.contents[0].text),
    ).toMatchObject({
      agentDoc: revisedDocs,
      objects: [expect.objectContaining({ className: 'Product' })],
    });
    const orderRead = await modernRequest('resources/read', 'resources/read', {
      uri: packageUri('orders'),
    });
    expect(JSON.parse(orderRead.body.result.contents[0].text)).toMatchObject({
      name: '@conformance/orders',
      objects: [expect.objectContaining({ className: 'Order' })],
    });
  });

  it('passes the official server suite with the reviewed baseline', async () => {
    const result = await runConformance(mcpUrl);
    expect(result.code, result.output).toBe(0);
  }, 240_000);
});

function runConformance(url: string) {
  return new Promise<{ code: number | null; output: string }>(
    (resolveRun, rejectRun) => {
      const child = spawn(
        conformanceBin,
        [
          'server',
          '--url',
          url,
          '--spec-version',
          '2026-07-28',
          '--expected-failures',
          baselinePath,
        ],
        { cwd: packageRoot, env: process.env },
      );
      children.add(child);
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        output += String(chunk);
      });
      child.on('error', rejectRun);
      child.on('close', (code) => {
        children.delete(child);
        resolveRun({ code, output });
      });
    },
  );
}

async function modernRequest(
  method: string,
  headerMethod = method,
  params: Record<string, unknown> = {},
) {
  const mcpName =
    typeof params.name === 'string'
      ? params.name
      : typeof params.uri === 'string'
        ? params.uri
        : undefined;
  const response = await fetch(
    new Request(mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-method': headerMethod,
        'mcp-protocol-version': '2026-07-28',
        ...(mcpName === undefined ? {} : { 'mcp-name': mcpName }),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
            [CLIENT_INFO_META_KEY]: {
              name: 'smrt-conformance',
              version: '0.0.0',
            },
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
        },
      }),
    }),
  );
  return { status: response.status, body: (await response.json()) as any };
}

function packageUri(name: string) {
  return `smrt://knowledge/package/${encodeURIComponent(`@conformance/${name}`)}`;
}

async function writeFixturePackage(name: string, model: string) {
  const directory = join(fixtureRoot, 'packages', name);
  await mkdir(join(directory, 'src', 'manifest'), { recursive: true });
  const packageName = `@conformance/${name}`;
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({
      name: packageName,
      version: '1.0.0',
      type: 'module',
    }),
  );
  await writeFile(
    join(directory, 'AGENTS.md'),
    `# ${name}\n\nConsumer model documentation.\n`,
  );
  await writeFile(join(directory, 'CLAUDE.md'), '@AGENTS.md\n');
  await writeFile(
    join(directory, 'src', 'manifest', 'manifest.json'),
    JSON.stringify({
      version: '1',
      packageName,
      objects: {
        [`${packageName}:${model}`]: {
          className: model,
          qualifiedName: `${packageName}:${model}`,
          extends: 'SmrtObject',
          collection: `${name}_items`,
          fields: { title: { type: 'text', required: true } },
          methods: {},
        },
      },
    }),
  );
}

async function stopChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveStop, rejectStop) => {
    const forceTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    const deadline = setTimeout(() => {
      cleanup();
      rejectStop(new Error('Conformance child did not terminate'));
    }, 6_000);
    const onClose = () => {
      cleanup();
      resolveStop();
    };
    function cleanup() {
      clearTimeout(forceTimer);
      clearTimeout(deadline);
      child.off('close', onClose);
      children.delete(child);
    }
    child.once('close', onClose);
    child.kill('SIGTERM');
  });
}
