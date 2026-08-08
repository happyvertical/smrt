import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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
    const packOutput = execFileSync(
      'npm',
      ['pack', '--json', '--pack-destination', packedTempDir],
      { cwd: packageRoot, encoding: 'utf8' },
    );
    const jsonStart = packOutput.lastIndexOf('\n[');
    const packed = JSON.parse(packOutput.slice(jsonStart + 1));
    const tarball = join(packedTempDir, packed[0].filename);
    const unpackDir = join(packedTempDir, 'unpacked');
    mkdirSync(unpackDir);
    execFileSync('tar', ['-xzf', tarball, '-C', unpackDir], {
      cwd: packedTempDir,
    });

    const unpackedPackageRoot = join(unpackDir, 'package');
    // The tarball intentionally excludes node_modules. Link the already
    // installed runtime dependency graph so the packed package itself remains
    // the process root while this offline verification runs.
    symlinkSync(join(packageRoot, 'node_modules'), join(unpackedPackageRoot, 'node_modules'));
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
      cwd: unpackedPackageRoot,
      stderr: 'pipe',
    });
    const packedClient = new Client(
      { name: 'smrt-dev-mcp-packed-plugin-verify', version: '1.0.0' },
      {
        capabilities: {},
        versionNegotiation: { mode: { pin: '2026-07-28' } },
      },
    );

    try {
      await packedClient.connect(packedTransport);
      const tools = await packedClient.listTools();
      if (!tools.tools.some((tool) => tool.name === 'get-agent-skill')) {
        throw new Error('Packed plugin server did not complete tools/list');
      }
    } finally {
      await packedClient.close();
      await packedTransport.close();
    }
  } finally {
    rmSync(packedTempDir, { recursive: true, force: true });
  }
}
