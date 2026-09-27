import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { validateAgentPlugin } from './verify-agent-plugin.mjs';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const indexJs = join(packageRoot, 'dist', 'index.js');
const knowledgeDts = join(packageRoot, 'dist', 'knowledge.d.ts');

if (!existsSync(indexJs)) {
  throw new Error('Missing built MCP entrypoint: dist/index.js');
}

if (!readFileSync(indexJs, 'utf8').startsWith('#!/usr/bin/env node')) {
  throw new Error('Built MCP entrypoint is missing its shebang');
}

if (!existsSync(knowledgeDts)) {
  throw new Error('Missing public knowledge type entry: dist/knowledge.d.ts');
}

const tempDir = mkdtempSync(join(tmpdir(), 'smrt-dev-mcp-bin-'));
const symlinkedBin = join(tempDir, 'smrt-dev-mcp');
symlinkSync(indexJs, symlinkedBin);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [symlinkedBin],
  cwd: packageRoot,
  stderr: 'pipe',
});
const client = new Client(
  { name: 'smrt-dev-mcp-verify-pack', version: '1.0.0' },
  {
    capabilities: {},
    versionNegotiation: { mode: { pin: '2026-07-28' } },
  },
);

try {
  await verifyPackedPlugin();

  await client.connect(transport);
  const tools = await client.listTools();
  if (!tools.tools.some((tool) => tool.name === 'get-agent-skill')) {
    throw new Error('Built MCP server did not list get-agent-skill');
  }

  const result = await client.callTool({
    name: 'get-agent-skill',
    arguments: { name: 'smrt-code-review' },
  });
  const content = result.content?.[0];
  const text = content?.type === 'text' ? content.text : '';
  if (!text.includes('name: smrt-code-review')) {
    throw new Error('Built MCP server could not load smrt-code-review skill');
  }
} finally {
  await client.close();
  await transport.close();
  rmSync(tempDir, { recursive: true, force: true });
}

console.log('smrt-dev-mcp build artifacts verified');

async function verifyPackedPlugin() {
  const packedTempDir = mkdtempSync(join(tmpdir(), 'smrt-dev-mcp-plugin-'));
  try {
    function pack(directory) {
      const pkg = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
      execFileSync('pnpm', ['pack', '--pack-destination', packedTempDir], {
        cwd: directory,
        encoding: 'utf8',
      });
      return join(packedTempDir, `${pkg.name.replace('@', '').replace('/', '-')}-${pkg.version}.tgz`);
    }
    // Include the workspace siblings changed by this release. pnpm pack rewrites
    // workspace: ranges; npm then installs the real production graph outside
    // the checkout, with an empty cache and no borrowed node_modules links.
    const tarballs = [
      pack(packageRoot),
      pack(resolve(packageRoot, '../scanner')),
      pack(resolve(packageRoot, '../types')),
    ];
    const consumerRoot = join(packedTempDir, 'consumer');
    mkdirSync(consumerRoot);
    writeFileSync(join(consumerRoot, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--cache', join(packedTempDir, 'cache'), ...tarballs], {
      cwd: consumerRoot,
      encoding: 'utf8',
    });
    const installed = JSON.parse(readFileSync(join(consumerRoot, 'package-lock.json'), 'utf8')).packages;
    for (const forbidden of ['@happyvertical/smrt-core', '@happyvertical/sql', '@happyvertical/files', '@happyvertical/ai']) {
      if (Object.keys(installed).some((path) => path.endsWith(`node_modules/${forbidden}`))) {
        throw new Error(`Cold MCP install unexpectedly includes ${forbidden}`);
      }
    }
    const unpackedPackageRoot = join(consumerRoot, 'node_modules', '@happyvertical', 'smrt-dev-mcp');
    for (const path of [
      'plugin.json',
      'mcp.json',
      'skills/smrt-code-review/SKILL.md',
      'schemas/agent-plugins-1.0.0/plugin.schema.json',
      'schemas/agent-plugins-1.0.0/mcp.schema.json',
    ]) {
      if (!existsSync(join(unpackedPackageRoot, path))) {
        throw new Error(`Packed plugin is missing ${path}`);
      }
    }

    const { mcp } = validateAgentPlugin(unpackedPackageRoot);
    const server = mcp.mcpServers['smrt-dev-mcp'];
    const executable = join(unpackedPackageRoot, server.command);
    if ((statSync(executable).mode & 0o111) === 0) {
      throw new Error('Packed plugin stdio executable is not executable');
    }

    // StdioClientTransport spawns this token directly with shell: false. Its
    // Client handshake performs server/discover before this explicit tools/list.
    const packedTransport = new StdioClientTransport({
      command: executable,
      args: server.args ?? [],
      cwd: consumerRoot,
      stderr: 'pipe',
    });
    const packedClient = new Client(
      { name: 'smrt-dev-mcp-packed-plugin-verify', version: '1.0.0' },
      {
        capabilities: {},
        versionNegotiation: { mode: { pin: '2026-07-28' } },
      },
    );

    const protocolErrors = [];
    packedClient.onerror = (error) => protocolErrors.push(error);
    try {
      await packedClient.connect(packedTransport);
      const tools = await packedClient.listTools();
      if (tools.tools.length !== 21 || !tools.tools.some((tool) => tool.name === 'runtime-schema-diff')) {
        throw new Error('Packed plugin did not preserve the complete 21-tool catalog');
      }
      const generated = await packedClient.callTool({ name: 'generate-smrt-class', arguments: { className: 'ColdEntry', properties: [] } });
      if (generated.isError) throw new Error('Cold static generation failed');
      const knowledge = await packedClient.callTool({ name: 'reflect-knowledge', arguments: { rootDir: consumerRoot } });
      if (knowledge.isError) throw new Error('Cold static knowledge failed');
      const missing = await packedClient.callTool({ name: 'runtime-registry', arguments: {} });
      if (missing.structuredContent?.diagnostics?.[0]?.code !== 'runtime_dependency_unavailable') {
        throw new Error('Cold runtime setup must return an actionable missing-runtime diagnostic');
      }
      const missingDatabaseRuntime = await packedClient.callTool({ name: 'migration-status', arguments: {} });
      if (missingDatabaseRuntime.structuredContent?.diagnostics?.[0]?.code !== 'runtime_dependency_unavailable') {
        throw new Error('Cold migration status without overrides must preserve missing-runtime setup diagnostics');
      }
      if (protocolErrors.length) throw new Error('Packed MCP wrote invalid protocol output');
    } finally {
      await packedClient.close();
      await packedTransport.close();
    }
  } finally {
    rmSync(packedTempDir, { recursive: true, force: true });
  }
}
