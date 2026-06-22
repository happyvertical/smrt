/**
 * Integration test for the mcp-advisor stdio server (src/mcp-advisor/index.ts).
 *
 * The advisor's main() only runs when the module is the process entrypoint
 * (guarded by isEntrypoint()), so the stdio transport can only be exercised by
 * launching it as a subprocess. Following the established pattern in
 * packages/smrt-dev-mcp/src/mcp-stdio.test.ts we spawn it via `tsx` and drive it
 * with a real MCP Client. This exercises the ListTools handler, the CallTool
 * routing switch, the success-response formatter, and the error-response path.
 * The in-process unit tests for TOOLS and handleToolCall live in index.test.ts.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '..', '..');
const repoRoot = resolve(packageRoot, '..', '..');
const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');

let activeClient: Client | undefined;
let activeTransport: StdioClientTransport | undefined;

async function createMcpClient() {
  expect(existsSync(tsxBin)).toBe(true);

  const transport = new StdioClientTransport({
    command: tsxBin,
    args: ['src/mcp-advisor/index.ts'],
    cwd: packageRoot,
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'smrt-advisor-smoke-test', version: '1.0.0' },
    { capabilities: {} },
  );

  activeClient = client;
  activeTransport = transport;
  await client.connect(transport);
  return client;
}

function textContent(result: Awaited<ReturnType<Client['callTool']>>): string {
  if (!('content' in result) || !Array.isArray(result.content)) {
    return JSON.stringify(result);
  }
  const first = result.content[0];
  if (!first || first.type !== 'text') {
    throw new Error('Expected text MCP response');
  }
  return first.text;
}

afterEach(async () => {
  await activeClient?.close();
  await activeTransport?.close();
  activeClient = undefined;
  activeTransport = undefined;
});

describe('mcp-advisor stdio server', () => {
  it('lists all advisor tools, routes calls, and surfaces handler errors', async () => {
    const client = await createMcpClient();

    // ── ListTools ────────────────────────────────────────────────────────
    const listResult = await client.listTools();
    const toolNames = listResult.tools.map((t) => t.name);
    expect(toolNames).toEqual(
      expect.arrayContaining([
        'generate-smrt-class',
        'add-ai-methods',
        'generate-field-definitions',
        'generate-collection',
        'configure-decorators',
        'validate-smrt-object',
        'preview-api-endpoints',
        'preview-mcp-tools',
        'list-registered-objects',
        'get-object-schema',
        'get-object-config',
      ]),
    );
    // Each tool carries an input schema.
    for (const tool of listResult.tools) {
      expect(tool.inputSchema).toBeTruthy();
    }

    // ── CallTool: pure generator route (object result → JSON.stringify) ───
    const genResult = await client.callTool({
      name: 'generate-smrt-class',
      arguments: {
        className: 'Widget',
        properties: [{ name: 'name', type: 'text', required: true }],
      },
    });
    const gen = JSON.parse(textContent(genResult));
    expect(gen.success).toBe(true);
    expect(gen.data).toContain('export class Widget extends SmrtObject');

    // ── CallTool: configure-decorators route ─────────────────────────────
    const cfgResult = await client.callTool({
      name: 'configure-decorators',
      arguments: { className: 'Widget', cli: true },
    });
    const cfg = JSON.parse(textContent(cfgResult));
    expect(cfg.success).toBe(true);
    expect(cfg.data).toContain('cli: true');

    // ── CallTool: registry route (empty/whatever-is-registered) ──────────
    const listObjsResult = await client.callTool({
      name: 'list-registered-objects',
      arguments: {},
    });
    const listObjs = JSON.parse(textContent(listObjsResult));
    expect(listObjs).toHaveProperty('objects');
    expect(listObjs).toHaveProperty('total');
    expect(Array.isArray(listObjs.objects)).toBe(true);

    // ── CallTool: handler validation error → success:false response ───────
    const badGenResult = await client.callTool({
      name: 'generate-smrt-class',
      arguments: { className: 'lowercase', properties: [] },
    });
    const badGen = JSON.parse(textContent(badGenResult));
    expect(badGen.success).toBe(false);
    expect(badGen.error).toMatch(/PascalCase|property/);

    // ── CallTool: unknown tool → isError text response ───────────────────
    const unknownResult = await client.callTool({
      name: 'does-not-exist',
      arguments: {},
    });
    expect(unknownResult.isError).toBe(true);
    expect(textContent(unknownResult)).toMatch(
      /Error executing does-not-exist: Unknown tool/,
    );

    // ── CallTool: registry handler that throws → isError text response ────
    const previewErr = await client.callTool({
      name: 'preview-mcp-tools',
      arguments: { className: 'DefinitelyNotRegistered' },
    });
    expect(previewErr.isError).toBe(true);
    expect(textContent(previewErr)).toMatch(/not found in ObjectRegistry/);
  }, 60_000);
});
