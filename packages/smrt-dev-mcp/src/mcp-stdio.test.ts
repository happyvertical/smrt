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
      ]),
    );

    const reflectResult = await client.callTool({
      name: 'reflect-knowledge',
      arguments: { rootDir: repoRoot },
    });
    const reflect = JSON.parse(textContent(reflectResult));
    expect(reflect.smrtPackageCount).toBeGreaterThan(0);
    expect(reflect.freshness.ok).toBe(true);

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
