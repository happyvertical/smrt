import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '..');
const repoRoot = resolve(packageRoot, '..', '..');
const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');

let activeClient: Client | undefined;
let activeTransport: StdioClientTransport | undefined;

async function createMcpClient() {
  expect(existsSync(tsxBin)).toBe(true);

  const transport = new StdioClientTransport({
    command: tsxBin,
    args: ['src/index.ts'],
    cwd: packageRoot,
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'smrt-dev-mcp-smoke-test', version: '1.0.0' },
    { capabilities: {} },
  );

  activeClient = client;
  activeTransport = transport;
  await client.connect(transport);
  return client;
}

function textContent(result: Awaited<ReturnType<Client['callTool']>>): string {
  if (!('content' in result)) return JSON.stringify(result.toolResult);
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

describe('smrt-dev-mcp stdio server', () => {
  it('lists and calls knowledge tools over MCP stdio', async () => {
    const client = await createMcpClient();

    const listResult = await client.listTools();
    const toolNames = listResult.tools.map((tool) => tool.name);

    expect(toolNames).toEqual(
      expect.arrayContaining([
        'reflect-knowledge',
        'check-knowledge-freshness',
        'build-review-context',
        'build-architecture-context',
        'smrt-review',
        'smrt-architecture',
        'list-agent-skills',
        'get-agent-skill',
      ]),
    );

    const reflectResult = await client.callTool({
      name: 'reflect-knowledge',
      arguments: { rootDir: repoRoot },
    });
    const reflect = JSON.parse(textContent(reflectResult));
    expect(reflect.smrtPackageCount).toBeGreaterThan(0);
    expect(reflect.freshness.ok).toBe(true);

    const reviewResult = await client.callTool({
      name: 'build-review-context',
      arguments: {
        rootDir: repoRoot,
        changedFiles: ['packages/content/src/models/Article.ts'],
      },
    });
    const review = JSON.parse(textContent(reviewResult));
    expect(
      review.selectedPackages.map((pkg: { name: string }) => pkg.name),
    ).toContain('@happyvertical/smrt-content');
    expect(review.promptBundle.contextMarkdown).toContain('SMRT code review');

    const architectureResult = await client.callTool({
      name: 'build-architecture-context',
      arguments: {
        rootDir: repoRoot,
        idea: 'Publishing workflow with profiles and scheduled social posts',
      },
    });
    const architecture = JSON.parse(textContent(architectureResult));
    expect(
      architecture.selectedPackages.map((pkg: { name: string }) => pkg.name),
    ).toEqual(expect.arrayContaining(['@happyvertical/smrt-profiles']));
    expect(architecture.promptBundle.contextMarkdown).toContain(
      'SMRT architecture planning',
    );

    const skillsResult = await client.callTool({
      name: 'list-agent-skills',
      arguments: {},
    });
    const skills = JSON.parse(textContent(skillsResult));
    expect(
      skills.skills.map((skill: { name: string }) => skill.name),
    ).toContain('smrt-review');

    const skillResult = await client.callTool({
      name: 'get-agent-skill',
      arguments: { name: 'smrt-review' },
    });
    const skill = JSON.parse(textContent(skillResult));
    expect(skill.skillMarkdown).toContain('name: smrt-review');
    expect(skill.skillMarkdown).toContain('Call MCP tool `smrt-review`');
    expect(skill.referenceFiles[0].content).toContain('SMRT Review Output');
  });
});
