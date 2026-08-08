import { type ChildProcess, spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCPGenerator } from '@happyvertical/smrt-core/generators/mcp';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  SERVER_INFO_META_KEY,
} from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import './fixture-objects.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(packageRoot, '..', '..');
const generatedDir = join(packageRoot, '.generated-tmp');
const generatedPath = join(generatedDir, 'index.ts');
const generatedDatabasePath = join(generatedDir, 'fixture.sqlite');
const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
const conformanceBin = join(packageRoot, 'node_modules', '.bin', 'conformance');
const baselinePath = join(packageRoot, 'conformance-baseline.yml');
let httpChild: ChildProcess | undefined;
let mcpUrl: string;
const originalDatabaseUrl = process.env.DATABASE_URL;
const originalDatabaseType = process.env.DATABASE_TYPE;

beforeAll(async () => {
  await rm(generatedDir, { force: true, recursive: true });
  await mkdir(generatedDir, { recursive: true });
  await getTestDatabase({
    type: 'sqlite',
    url: generatedDatabasePath,
    classes: ['ConformanceAnimal', 'ConformanceCat'],
  });
  process.env.DATABASE_TYPE = 'sqlite';
  process.env.DATABASE_URL = generatedDatabasePath;
  const generator = new MCPGenerator({
    name: 'smrt-generated-conformance',
    version: '0.0.0',
    description: 'Generated Tier-1 MCP conformance fixture',
  });
  await generator.generateServer({ outputPath: generatedPath });

  const transport = new StdioClientTransport({
    command: tsxBin,
    args: [generatedPath],
    cwd: packageRoot,
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'generated-fixture-test', version: '0.0.0' },
    {
      capabilities: {},
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    },
  );
  try {
    await client.connect(transport);
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    expect(client.getDiscoverResult()).toBeDefined();
    expect(client.getServerVersion()).toMatchObject({
      name: 'smrt-generated-conformance',
      version: '0.0.0',
    });
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'conformancewidget_list',
        'conformancegadget_create',
        'conformanceanimal_create',
      ]),
    );
    const listTool = tools.tools.find(
      (tool) => tool.name === 'conformancewidget_list',
    );
    expect(listTool).toMatchObject({
      inputSchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
      },
      outputSchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
      },
    });
  } finally {
    await client.close();
    await transport.close();
  }

  mcpUrl = await startHttpAdapter();
});

afterAll(async () => {
  httpChild?.kill('SIGTERM');
  if (originalDatabaseType === undefined) {
    delete process.env.DATABASE_TYPE;
  } else {
    process.env.DATABASE_TYPE = originalDatabaseType;
  }
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
  if (process.env.MCP_CONFORMANCE_KEEP_GENERATED !== 'true') {
    await rm(generatedDir, { force: true, recursive: true });
  }
});

describe('generated Tier-1 MCP 2026-07-28 conformance', () => {
  it('creates an advertised STI subtype through the generated runtime', async () => {
    const transport = new StdioClientTransport({
      command: tsxBin,
      args: [generatedPath],
      cwd: packageRoot,
      stderr: 'pipe',
      env: {
        DATABASE_TYPE: 'sqlite',
        DATABASE_URL: generatedDatabasePath,
      },
    });
    const client = new Client(
      { name: 'generated-sti-test', version: '0.0.0' },
      {
        capabilities: {},
        versionNegotiation: { mode: { pin: '2026-07-28' } },
      },
    );
    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: 'conformanceanimal_create',
        arguments: {
          name: 'Mittens',
          lives: 7,
          _meta_type:
            '@happyvertical/smrt-mcp-conformance-fixture:ConformanceCat',
        },
      });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        name: 'Mittens',
        lives: 7,
        _meta_type:
          '@happyvertical/smrt-mcp-conformance-fixture:ConformanceCat',
      });
    } finally {
      await client.close();
      await transport.close();
    }
  });

  it('answers discover with SDK-stamped complete metadata', async () => {
    const response = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-method': 'server/discover',
        'mcp-protocol-version': '2026-07-28',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'server/discover',
        params: {
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
            [CLIENT_INFO_META_KEY]: {
              name: 'generated-fixture-test',
              version: '0.0.0',
            },
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
        },
      }),
    });
    const body = (await response.json()) as any;
    expect(body.result).toMatchObject({
      supportedVersions: ['2026-07-28'],
      resultType: 'complete',
      _meta: { [SERVER_INFO_META_KEY]: { name: 'smrt-generated-conformance' } },
    });
  });

  it('passes the official server suite with the reviewed baseline', async () => {
    const result = await run(conformanceBin, [
      'server',
      '--url',
      mcpUrl,
      '--spec-version',
      '2026-07-28',
      '--expected-failures',
      baselinePath,
    ]);
    expect(result.code, result.output).toBe(0);
  });
});

function startHttpAdapter(): Promise<string> {
  return new Promise((resolveUrl, rejectStart) => {
    httpChild = spawn(tsxBin, ['scripts/serve-generated.ts', generatedPath], {
      cwd: packageRoot,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    httpChild.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    httpChild.on('error', rejectStart);
    httpChild.on('exit', (code) => {
      if (code !== null && code !== 0) rejectStart(new Error(stderr));
    });
    httpChild.stdout?.once('data', (chunk) => resolveUrl(String(chunk).trim()));
  });
}

function run(command: string, args: string[]) {
  return new Promise<{ code: number | null; output: string }>(
    (resolveRun, rejectRun) => {
      const child = spawn(command, args, {
        cwd: packageRoot,
        env: process.env,
      });
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += String(chunk);
      });
      child.stderr.on('data', (chunk) => {
        output += String(chunk);
      });
      child.on('error', rejectRun);
      child.on('close', (code) => resolveRun({ code, output }));
    },
  );
}
