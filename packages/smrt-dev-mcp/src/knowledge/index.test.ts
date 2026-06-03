import { mkdir, rm, writeFile } from 'node:fs/promises';
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
