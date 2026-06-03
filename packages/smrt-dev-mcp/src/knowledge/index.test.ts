import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildKnowledgeIndex,
  buildReviewContext,
  checkKnowledgeFreshness,
  smrtArchitecture,
  smrtReview,
} from './index.js';

describe('SMRT knowledge index', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = join(tmpdir(), `smrt-knowledge-${Date.now()}`);
    await mkdir(join(rootDir, 'packages', 'demo', 'src', 'manifest'), {
      recursive: true,
    });
    await writeFile(
      join(rootDir, 'pnpm-workspace.yaml'),
      "packages:\n  - 'packages/*'\n",
    );
    await writeFile(
      join(rootDir, 'packages', 'demo', 'package.json'),
      JSON.stringify(
        {
          name: '@happyvertical/smrt-demo',
          version: '1.0.0',
          type: 'module',
          author: 'HappyVertical',
          files: ['dist', 'AGENTS.md', 'CLAUDE.md'],
          exports: {
            '.': {
              types: './dist/index.d.ts',
              import: './dist/index.js',
            },
            './tools': {
              types: './dist/tools.d.ts',
              import: './dist/tools.js',
            },
          },
          dependencies: {
            '@happyvertical/smrt-core': 'workspace:*',
            '@happyvertical/sql': 'catalog:',
          },
        },
        null,
        2,
      ),
    );
    await writeFile(
      join(rootDir, 'packages', 'demo', 'AGENTS.md'),
      '# Demo\n\nPackage-specific expert guidance.',
    );
    await writeFile(
      join(rootDir, 'packages', 'demo', 'CLAUDE.md'),
      '@AGENTS.md\n',
    );
    await writeFile(
      join(rootDir, 'packages', 'demo', 'src', 'manifest', 'manifest.json'),
      JSON.stringify(
        {
          version: '1',
          packageName: '@happyvertical/smrt-demo',
          objects: {
            '@happyvertical/smrt-demo:Demo': {
              className: 'Demo',
              qualifiedName: '@happyvertical/smrt-demo:Demo',
              extends: 'SmrtObject',
              collection: 'demos',
              decoratorConfig: {
                mcp: {
                  include: ['list', 'get'],
                },
              },
              fields: {
                ownerId: {
                  type: 'foreignKey',
                  required: true,
                  related: 'Owner',
                },
                profileId: {
                  type: 'crossPackageRef',
                  related: '@happyvertical/smrt-profiles:Profile',
                },
              },
              schema: {
                tableName: 'demos',
                columns: {
                  id: { type: 'UUID' },
                  owner_id: { type: 'UUID' },
                  profile_id: { type: 'UUID' },
                },
              },
            },
            '@happyvertical/smrt-demo:DemoLinks': {
              className: 'DemoLinks',
              qualifiedName: '@happyvertical/smrt-demo:DemoLinks',
              extends: 'SmrtJunction',
              collection: 'demo_links',
              fields: {},
              methods: {
                byLeft: { name: 'byLeft' },
              },
            },
            '@happyvertical/smrt-demo:DemoTree': {
              className: 'DemoTree',
              qualifiedName: '@happyvertical/smrt-demo:DemoTree',
              extends: 'SmrtHierarchical',
              collection: 'demo_trees',
              fields: {
                parentId: { type: 'foreignKey', related: 'DemoTree' },
              },
              schema: {
                columns: {
                  id: { type: 'UUID' },
                  parent_id: { type: 'UUID' },
                },
              },
            },
            '@happyvertical/smrt-demo:DemoAssociation': {
              className: 'DemoAssociation',
              qualifiedName: '@happyvertical/smrt-demo:DemoAssociation',
              extends: 'SmrtObject',
              collection: 'demo_associations',
              fields: {
                metaType: { type: 'text', required: true },
                metaId: { type: 'text', required: true },
                role: { type: 'text', required: true },
              },
            },
          },
        },
        null,
        2,
      ),
    );
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('indexes relationships-v2 facts from package manifests', async () => {
    const index = await buildKnowledgeIndex({ rootDir });

    expect(index.smrtPackages).toHaveLength(1);
    expect(index.smrtPackages[0].hasAgentsMd).toBe(true);
    expect(index.smrtPackages[0].hasClaudeShim).toBe(true);
    expect(index.smrtPackages[0].sdkDependencies).toEqual([
      '@happyvertical/sql',
    ]);
    expect(index.smrtPackages[0].exportKeys).toEqual(['.', './tools']);
    expect(index.smrtPackages[0].mcpTools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['get_demos', 'list_demos']),
    );
    expect(index.relationshipsV2.foreignKeyFields).toBe(2);
    expect(index.relationshipsV2.crossPackageRefFields).toBe(1);
    expect(index.relationshipsV2.junctionCollections).toBe(1);
    expect(index.relationshipsV2.hierarchicalObjects).toBe(1);
    expect(index.relationshipsV2.polymorphicAssociations).toBe(1);
    expect(index.relationshipsV2.uuidColumns).toBe(3);
  });

  it('filters the index by package scope and package name', async () => {
    const index = await buildKnowledgeIndex({
      rootDir,
      scope: 'package',
      package: 'demo',
    });

    expect(index.packages.map((pkg) => pkg.name)).toEqual([
      '@happyvertical/smrt-demo',
    ]);
    expect(index.sdkPackages).toHaveLength(0);
  });

  it('loads domain knowledge artifacts before raw manifest fallback', async () => {
    await mkdir(join(rootDir, 'packages', 'demo', '.smrt'), {
      recursive: true,
    });
    await writeFile(
      join(rootDir, 'packages', 'demo', '.smrt', 'smrt-knowledge.json'),
      JSON.stringify(
        {
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          packageName: '@happyvertical/smrt-demo',
          packageVersion: '1.0.0',
          sourceHashes: {},
          exports: ['.', './smrt-knowledge.json'],
          dependencies: {
            '@happyvertical/smrt-core': 'workspace:*',
            '@happyvertical/sql': 'catalog:',
          },
          smrtDependencies: ['@happyvertical/smrt-core'],
          sdkDependencies: ['@happyvertical/sql'],
          tags: ['fixture'],
          risks: [],
          objects: [
            {
              name: 'ArtifactDemo',
              qualifiedName: '@happyvertical/smrt-demo:ArtifactDemo',
              collection: 'artifact_demos',
              fields: [
                {
                  name: 'profileId',
                  type: 'crossPackageRef',
                  related: '@happyvertical/smrt-profiles:Profile',
                  columnType: 'UUID',
                },
              ],
              relationships: [
                {
                  name: 'profileId',
                  type: 'crossPackageRef',
                  related: '@happyvertical/smrt-profiles:Profile',
                  columnType: 'UUID',
                },
              ],
              methods: ['sync'],
              surfaces: [
                {
                  kind: 'mcp',
                  name: 'artifactdemo_sync',
                  operation: 'sync',
                  objectName: '@happyvertical/smrt-demo:ArtifactDemo',
                },
              ],
              relationshipFeatures: ['crossPackageRef', 'uuidColumns'],
              tags: ['artifact'],
              risks: [],
            },
          ],
          surfaces: [
            {
              kind: 'mcp',
              name: 'artifactdemo_sync',
              operation: 'sync',
              objectName: '@happyvertical/smrt-demo:ArtifactDemo',
            },
          ],
          prompts: [{ filePath: 'src/prompts/review.ts', key: 'demo.review' }],
          relationshipsV2: {
            foreignKeyFields: 0,
            crossPackageRefFields: 1,
            junctionCollections: 0,
            hierarchicalObjects: 0,
            polymorphicAssociations: 0,
            uuidColumns: 1,
          },
          agentDoc: '# Artifact guidance',
        },
        null,
        2,
      ),
    );

    const index = await buildKnowledgeIndex({ rootDir });
    const demo = index.packages.find(
      (pkg) => pkg.name === '@happyvertical/smrt-demo',
    );

    expect(demo?.hasDomainKnowledge).toBe(true);
    expect(demo?.domainKnowledgePath).toBe(
      'packages/demo/.smrt/smrt-knowledge.json',
    );
    expect(demo?.objects.map((object) => object.className)).toEqual([
      'ArtifactDemo',
    ]);
    expect(demo?.mcpTools.map((tool) => tool.name)).toEqual([
      'artifactdemo_sync',
    ]);
    expect(demo?.agentDoc).toContain('Artifact guidance');
  });

  it('fails freshness when exported domain knowledge is missing', async () => {
    const pkgPath = join(rootDir, 'packages', 'demo', 'package.json');
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
    pkg.exports['./smrt-knowledge.json'] = './dist/smrt-knowledge.json';
    await writeFile(pkgPath, JSON.stringify(pkg, null, 2));

    const result = await checkKnowledgeFreshness({ rootDir });
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain(
      'missing-domain-knowledge',
    );
  });

  it('fails freshness when package docs are missing or shim drifted', async () => {
    await writeFile(
      join(rootDir, 'packages', 'demo', 'CLAUDE.md'),
      '# Drift\n',
    );
    const result = await checkKnowledgeFreshness({ rootDir });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain(
      'claude-not-shim',
    );
  });

  it('reports package files allowlist issues with relative paths', async () => {
    await writeFile(
      join(rootDir, 'packages', 'demo', 'package.json'),
      JSON.stringify(
        {
          name: '@happyvertical/smrt-demo',
          version: '1.0.0',
          type: 'module',
          files: ['dist'],
        },
        null,
        2,
      ),
    );

    const result = await checkKnowledgeFreshness({ rootDir });
    const packageFileIssues = result.issues.filter((issue) =>
      issue.code.startsWith('package-files-missing-'),
    );

    expect(packageFileIssues.map((issue) => issue.file)).toEqual([
      'packages/demo/package.json',
      'packages/demo/package.json',
    ]);
  });

  it('checks staged files when changed mode is enabled', async () => {
    execFileSync('git', ['init'], { cwd: rootDir });
    await writeFile(
      join(rootDir, 'README.md'),
      `Legacy import: @${'have'}/sql\n`,
    );
    execFileSync('git', ['add', 'README.md'], { cwd: rootDir });

    const result = await checkKnowledgeFreshness({
      rootDir,
      changed: true,
      strict: true,
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain(
      'stale-have-namespace',
    );
  });

  it('ignores changelog stale patterns when changed mode is enabled', async () => {
    execFileSync('git', ['init'], { cwd: rootDir });
    await writeFile(
      join(rootDir, 'packages', 'demo', 'CHANGELOG.md'),
      `Historical note: @happyvertical/smrt-core/${'fields'}\n`,
    );
    execFileSync('git', ['add', 'packages/demo/CHANGELOG.md'], {
      cwd: rootDir,
    });

    const result = await checkKnowledgeFreshness({
      rootDir,
      changed: true,
      strict: true,
    });

    expect(result.ok).toBe(true);
  });

  it('detects lowercase stale docs codex commands in changed markdown', async () => {
    execFileSync('git', ['init'], { cwd: rootDir });
    await writeFile(
      join(rootDir, 'README.md'),
      `Run smrt docs:${'codex'} before review.\n`,
    );
    execFileSync('git', ['add', 'README.md'], { cwd: rootDir });

    const result = await checkKnowledgeFreshness({
      rootDir,
      changed: true,
      strict: true,
    });

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toContain(
      'stale-docs-codex-command',
    );
  });

  it('does not scan changed source files for stale doc patterns', async () => {
    execFileSync('git', ['init'], { cwd: rootDir });
    await mkdir(join(rootDir, 'packages', 'demo', 'src'), { recursive: true });
    await writeFile(
      join(rootDir, 'packages', 'demo', 'src', 'example.ts'),
      `export const command = "docs:${'codex'}";\n`,
    );
    execFileSync('git', ['add', 'packages/demo/src/example.ts'], {
      cwd: rootDir,
    });

    const result = await checkKnowledgeFreshness({
      rootDir,
      changed: true,
      strict: true,
    });

    expect(result.ok).toBe(true);
  });

  it('builds review context with selected package and prompt bundle', async () => {
    const result = await buildReviewContext({
      rootDir,
      changedFiles: ['packages/demo/src/demo.ts'],
      focus: 'Check relationship declarations.',
    });

    expect(result.selectedPackages.map((pkg) => pkg.name)).toEqual([
      '@happyvertical/smrt-demo',
    ]);
    expect(result.promptBundle.contextMarkdown).toContain(
      '@happyvertical/smrt-demo',
    );
  });

  it('returns deterministic review findings for relationship and MCP surfaces', async () => {
    const result = await smrtReview({
      rootDir,
      changedFiles: ['packages/demo/src/Demo.ts'],
      mode: 'both',
    });

    expect(result.deterministicFindings.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'relationship-sensitive-review',
        'mcp-surface-review',
      ]),
    );
  });

  it('honors smrt-review mode selection', async () => {
    const findingsOnly = await smrtReview({
      rootDir,
      changedFiles: ['packages/demo/src/Demo.ts'],
      mode: 'findings',
    });
    const promptOnly = await smrtReview({
      rootDir,
      changedFiles: ['packages/demo/src/Demo.ts'],
      mode: 'prompt-bundle',
    });

    expect(findingsOnly).toHaveProperty('deterministicFindings');
    expect(findingsOnly).not.toHaveProperty('promptBundle');
    expect(promptOnly).not.toHaveProperty('deterministicFindings');
    expect(promptOnly).toHaveProperty('promptBundle');
  });

  it('flags manifest, public entrypoint, and expert doc changes for deterministic review', async () => {
    const result = await smrtReview({
      rootDir,
      changedFiles: [
        'packages/demo/package.json',
        'packages/demo/src/index.ts',
        'packages/demo/AGENTS.md',
      ],
      mode: 'both',
    });

    expect(result.deterministicFindings.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'package-manifest-review',
        'public-entrypoint-review',
        'agent-expertise-review',
      ]),
    );
  });

  it('returns architecture recommendations with model sketch, risks, and questions', async () => {
    const result = await smrtArchitecture({
      rootDir,
      idea: 'A tenant-aware demo tree with owned assets and generated MCP tools',
    });

    expect(result.recommendations.smrtPackages).toContain(
      '@happyvertical/smrt-demo',
    );
    expect(result.recommendations.objectModelSketch.join('\n')).toContain(
      'Demo',
    );
    expect(result.recommendations.risks.join('\n')).toContain(
      'Hierarchical models',
    );
    expect(result.recommendations.questions.join('\n')).toContain(
      'tenant-scoped',
    );
  });
});
