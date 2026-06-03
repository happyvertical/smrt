import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

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
  { capabilities: {} },
);

try {
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
