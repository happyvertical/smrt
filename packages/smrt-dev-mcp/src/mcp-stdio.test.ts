import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDatabase } from '@happyvertical/sql';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '..');
const repoRoot = resolve(packageRoot, '..', '..');
const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');

let activeClient: Client | undefined;
let activeTransport: StdioClientTransport | undefined;
const temporaryDirectories: string[] = [];

async function createMcpClient(env: NodeJS.ProcessEnv = process.env) {
  expect(existsSync(tsxBin)).toBe(true);

  const transport = new StdioClientTransport({
    command: tsxBin,
    args: ['src/index.ts'],
    cwd: packageRoot,
    env,
    stderr: 'pipe',
  });
  const client = new Client(
    { name: 'smrt-dev-mcp-smoke-test', version: '1.0.0' },
    {
      capabilities: {},
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    },
  );

  activeClient = client;
  activeTransport = transport;
  await client.connect(transport);
  return client;
}

function textContent(result: Awaited<ReturnType<Client['callTool']>>): string {
  if (!('content' in result)) return JSON.stringify(result.toolResult);
  const first = result.content[0];
  if (first?.type !== 'text') {
    throw new Error('Expected text MCP response');
  }
  return first.text;
}

afterEach(async () => {
  await activeClient?.close();
  await activeTransport?.close();
  activeClient = undefined;
  activeTransport = undefined;
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('smrt-dev-mcp stdio server', () => {
  it('routes every operational diagnostic over MCP stdio', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'smrt-dev-mcp-stdio-'));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, 'runtime.sqlite');
    const database = await getDatabase({ type: 'sqlite', url: databasePath });
    await (database.client as { close?: () => Promise<void> }).close?.();
    const client = await createMcpClient({
      ...process.env,
      SMRT_DEV_DB_URL: databasePath,
      SMRT_DEV_DB_TYPE: 'sqlite',
    });

    const calls = [
      ['job-health', { limit: 3, staleAfterMs: 1_000 }],
      ['schedule-health', { limit: 4, staleAfterMs: 2_000 }],
      ['dispatch-health', { limit: 5, staleAfterMs: 3_000 }],
      [
        'recent-changes',
        { limit: 6, since: 1_700_000_000_000, tables: ['articles'] },
      ],
    ] as const;

    for (const [name, arguments_] of calls) {
      const result = await client.callTool({ name, arguments: arguments_ });
      expect(JSON.parse(textContent(result))).toMatchObject({
        status: 'unavailable',
        provenance: {
          source: 'runtime',
          observation: 'live-db',
          engine: 'sqlite',
        },
      });
    }
  });

  // This smoke spawns a real server and drives ~11 whole-workspace tool calls
  // against the smrt monorepo. Discovery now reaches every workspace member
  // (#2143), and a member without build artifacts falls back to an OXC source
  // scan — seconds per package on a cold CI runner, versus a fast artifact read
  // locally. The cost therefore tracks how much of the repo is prebuilt, so this
  // needs a budget well above the 30s default rather than a flaky margin.
  it('lists and calls knowledge tools over MCP stdio', {
    timeout: 300_000,
  }, async () => {
    const client = await createMcpClient();

    const listResult = await client.listTools();
    const toolNames = listResult.tools.map((tool) => tool.name);

    expect(toolNames).toEqual(
      expect.arrayContaining([
        'reflect-knowledge',
        'reflect-domain-knowledge',
        'check-knowledge-freshness',
        'check-domain-knowledge',
        'build-review-context',
        'build-domain-review-context',
        'build-architecture-context',
        'build-domain-architecture-context',
        'smrt-review',
        'smrt-architecture',
        'review-smrt-project',
        'list-agent-skills',
        'get-agent-skill',
        'migration-status',
        'job-health',
        'schedule-health',
        'dispatch-health',
        'recent-changes',
        'registry-drift',
      ]),
    );

    const staticOnlyResult = await client.callTool({
      name: 'migration-status',
      arguments: { rootDir: repoRoot },
    });
    expect(JSON.parse(textContent(staticOnlyResult))).toMatchObject({
      status: 'not-configured',
      mode: 'static-only',
      diagnostics: [{ code: 'runtime-not-configured' }],
    });

    const reflectResult = await client.callTool({
      name: 'reflect-knowledge',
      arguments: { rootDir: repoRoot },
    });
    const reflect = JSON.parse(textContent(reflectResult));
    expect(reflect.smrtPackageCount).toBeGreaterThan(0);
    expect(reflect.freshness.ok).toBe(true);
    expect(reflectResult).toMatchObject({
      structuredContent: {
        ok: true,
        coverage: expect.any(Object),
        diagnostics: expect.any(Array),
        data: expect.objectContaining({ smrtPackageCount: expect.any(Number) }),
      },
    });

    const domainReflectResult = await client.callTool({
      name: 'reflect-domain-knowledge',
      arguments: { rootDir: repoRoot },
    });
    const domainReflect = JSON.parse(textContent(domainReflectResult));
    expect(domainReflect.domainKnowledgePackageCount).toBeGreaterThanOrEqual(0);

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

    // #2143: the default MCP response is the budgeted summary — authored prose
    // and full domain manifests are referenced by path, not inlined.
    expect(review.detail).toBe('summary');
    const summaryPackage = review.selectedPackages.find(
      (pkg: { name: string }) => pkg.name === '@happyvertical/smrt-content',
    );
    expect(summaryPackage.agentDoc).toBeUndefined();
    expect(summaryPackage.domainKnowledge).toBeUndefined();
    expect(summaryPackage.objectCount).toBeGreaterThan(0);
    expect(summaryPackage.docs).toEqual(
      expect.arrayContaining(['packages/content/AGENTS.md']),
    );

    const fullReviewResult = await client.callTool({
      name: 'build-review-context',
      arguments: {
        rootDir: repoRoot,
        changedFiles: ['packages/content/src/models/Article.ts'],
        detail: 'full',
      },
    });
    const fullReview = JSON.parse(textContent(fullReviewResult));
    const fullPackage = fullReview.selectedPackages.find(
      (pkg: { name: string }) => pkg.name === '@happyvertical/smrt-content',
    );
    expect(fullPackage.agentDoc).toBeTruthy();
    expect(textContent(fullReviewResult).length).toBeGreaterThan(
      textContent(reviewResult).length,
    );

    const domainReviewResult = await client.callTool({
      name: 'build-domain-review-context',
      arguments: {
        rootDir: repoRoot,
        changedFiles: ['packages/content/src/models/Article.ts'],
        scope: 'package',
        package: 'content',
      },
    });
    const domainReview = JSON.parse(textContent(domainReviewResult));
    expect(
      domainReview.selectedPackages.map((pkg: { name: string }) => pkg.name),
    ).toContain('@happyvertical/smrt-content');

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

    const domainArchitectureResult = await client.callTool({
      name: 'build-domain-architecture-context',
      arguments: {
        rootDir: repoRoot,
        idea: 'Publishing workflow with profiles and scheduled social posts',
        scope: 'package',
        package: 'profiles',
      },
    });
    const domainArchitecture = JSON.parse(
      textContent(domainArchitectureResult),
    );
    expect(
      domainArchitecture.selectedPackages.map(
        (pkg: { name: string }) => pkg.name,
      ),
    ).toContain('@happyvertical/smrt-profiles');

    const skillsResult = await client.callTool({
      name: 'list-agent-skills',
      arguments: {},
    });
    const skills = JSON.parse(textContent(skillsResult));
    expect(
      skills.skills.map((skill: { name: string }) => skill.name),
    ).toContain('smrt-code-review');

    const skillResult = await client.callTool({
      name: 'get-agent-skill',
      arguments: { name: 'smrt-code-review' },
    });
    const skill = JSON.parse(textContent(skillResult));
    expect(skill.skillMarkdown).toContain('name: smrt-code-review');
    expect(skill.skillMarkdown).toContain('Call MCP tool `smrt-review`');
    expect(skill.referenceFiles[0].content).toContain('SMRT Review Output');

    const promptsResult = await client.listPrompts();
    expect(promptsResult.prompts.map((prompt) => prompt.name)).toEqual(
      expect.arrayContaining([
        'smrt-code-review',
        'domain-code-review',
        'domain-architecture',
      ]),
    );
    expect(
      promptsResult.prompts
        .find((prompt) => prompt.name === 'domain-code-review')
        ?.arguments?.map((argument) => argument.name),
    ).toContain('changedFiles');
    const promptResult = await client.getPrompt({ name: 'smrt-code-review' });
    expect(promptResult.messages[0]?.content.type).toBe('text');
    expect(
      promptResult.messages[0]?.content.type === 'text'
        ? promptResult.messages[0].content.text
        : '',
    ).toContain('name: smrt-code-review');

    const domainPromptResult = await client.getPrompt({
      name: 'domain-code-review',
      arguments: {
        rootDir: repoRoot,
        changedFiles: 'packages/content/src/models/Article.ts',
        scope: 'package',
        package: 'content',
      },
    });
    expect(
      domainPromptResult.messages[0]?.content.type === 'text'
        ? domainPromptResult.messages[0].content.text
        : '',
    ).toContain('SMRT code review');

    const architecturePromptResult = await client.getPrompt({
      name: 'domain-architecture',
      arguments: {
        rootDir: repoRoot,
        idea: 'Publishing workflow with profiles and scheduled social posts',
        scope: 'package',
        package: 'profiles',
      },
    });
    expect(
      architecturePromptResult.messages[0]?.content.type === 'text'
        ? architecturePromptResult.messages[0].content.text
        : '',
    ).toContain('SMRT architecture planning');

    const resourcesResult = await client.listResources();
    const resourceUris = resourcesResult.resources.map(
      (resource) => resource.uri,
    );
    expect(resourceUris).toEqual(
      expect.arrayContaining([
        'smrt-dev-mcp://agent-skills/smrt-code-review',
        'smrt://knowledge/project',
      ]),
    );
    const resourceResult = await client.readResource({
      uri: 'smrt-dev-mcp://agent-skills/smrt-code-review',
    });
    const resourceContent = resourceResult.contents[0];
    expect(
      resourceContent && 'text' in resourceContent ? resourceContent.text : '',
    ).toContain('name: smrt-code-review');

    const projectKnowledgeResult = await client.readResource({
      uri: 'smrt://knowledge/project',
    });
    const projectKnowledgeContent = projectKnowledgeResult.contents[0];
    const projectKnowledge = JSON.parse(
      projectKnowledgeContent && 'text' in projectKnowledgeContent
        ? projectKnowledgeContent.text
        : '{}',
    );
    expect(projectKnowledge.rootDir).toBe('.');
    expect(projectKnowledge.packages[0]).not.toHaveProperty('directory');
    // Installed dependencies are the packages whose paths are absolute and
    // outside the root, so this list is the one that leaks host paths if it is
    // carried over by a spread instead of rebuilt from sanitized entries
    // (#2275).
    expect(Array.isArray(projectKnowledge.installedPackages)).toBe(true);
    for (const pkg of projectKnowledge.installedPackages) {
      expect(pkg).not.toHaveProperty('directory');
    }

    const packageUri = resourceUris.find((uri) =>
      uri.startsWith('smrt://knowledge/package/'),
    );
    if (!packageUri) {
      throw new Error('Expected package knowledge resource URI');
    }
    const packageKnowledgeResult = await client.readResource({
      uri: packageUri,
    });
    const packageKnowledgeContent = packageKnowledgeResult.contents[0];
    const packageKnowledge = JSON.parse(
      packageKnowledgeContent && 'text' in packageKnowledgeContent
        ? packageKnowledgeContent.text
        : '{}',
    );
    expect(packageKnowledge).not.toHaveProperty('directory');

    await expect(
      client.readResource({
        uri: 'smrt://knowledge/package/not-a-package',
      }),
    ).rejects.toThrow(/Unknown knowledge package/);
  });
});
