import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildArchitectureContext,
  buildKnowledgeIndex,
  buildPackageSpecialistContext,
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
                tenantScoped: { mode: 'optional', field: 'workspaceId' },
                tableStrategy: 'sti',
                conflictColumns: [
                  'workspace_id',
                  'code',
                  'secret_id',
                  'legacy_secret_id',
                  'api_token_i_d',
                ],
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
                attempts: {
                  type: 'integer',
                  default: 0,
                  min: 0,
                  max: 5,
                  readonly: true,
                },
                preview: { type: 'text', _meta: { transient: true } },
                secretId: {
                  type: 'foreignKey',
                  related: 'Secret',
                  sensitive: true,
                },
                legacySecretId: {
                  type: 'foreignKey',
                  related: 'LegacySecret',
                  _meta: { sensitive: true },
                },
                apiTokenID: { type: 'text', _meta: { sensitive: true } },
              },
              methods: {
                sync: {
                  name: 'sync',
                  async: true,
                  parameters: [
                    { name: 'force', type: 'boolean', optional: true },
                  ],
                  returnType: 'Promise<void>',
                  isStatic: false,
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
              decoratorConfig: {
                tenantScoped: {
                  mode: 'required',
                  field: 'privateTenantId',
                },
                conflictColumns: ['left_id', 'right_id', 'private_tenant_id'],
              },
              fields: {
                leftId: {
                  type: 'foreignKey',
                  related: 'Left',
                  required: true,
                },
                rightId: {
                  type: 'foreignKey',
                  related: 'Right',
                  required: true,
                },
                privateTenantId: {
                  type: 'foreignKey',
                  related: 'Tenant',
                  sensitive: true,
                },
              },
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
    expect(index.relationshipsV2.foreignKeyFields).toBe(4);
    expect(index.relationshipsV2.crossPackageRefFields).toBe(1);
    expect(index.relationshipsV2.junctionCollections).toBe(1);
    expect(index.relationshipsV2.hierarchicalObjects).toBe(1);
    expect(index.relationshipsV2.polymorphicAssociations).toBe(1);
    expect(index.relationshipsV2.uuidColumns).toBe(3);
  });

  it('projects raw-manifest structural facts and filters sensitive fields', async () => {
    const index = await buildKnowledgeIndex({ rootDir });
    const demo = index.smrtPackages[0].objects.find(
      (object) => object.className === 'Demo',
    );

    expect(demo).toMatchObject({
      tenant: { scoped: true, mode: 'optional', field: 'workspaceId' },
      tableStrategy: 'sti',
      conflictColumns: ['workspace_id', 'code'],
      methods: ['sync'],
      methodSignatures: [
        {
          name: 'sync',
          async: true,
          params: ['force?: boolean'],
          returns: 'Promise<void>',
        },
      ],
    });
    expect(demo?.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'attempts',
          default: 0,
          constraints: { min: 0, max: 5 },
          readonly: true,
        }),
        expect.objectContaining({ name: 'preview', transient: true }),
      ]),
    );
    expect(demo?.fields.map((field) => field.name)).not.toEqual(
      expect.arrayContaining(['secretId', 'legacySecretId', 'apiTokenID']),
    );
    expect(demo?.relationships.map((field) => field.name)).not.toEqual(
      expect.arrayContaining(['secretId', 'legacySecretId', 'apiTokenID']),
    );
    const links = index.smrtPackages[0].objects.find(
      (object) => object.className === 'DemoLinks',
    );
    expect(links).toMatchObject({
      tenant: { scoped: true, mode: 'required' },
      conflictColumns: ['left_id', 'right_id'],
    });
    expect(JSON.stringify(links)).not.toContain('privateTenantId');
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

  it('builds deterministic package specialist context', async () => {
    await writeFile(
      join(rootDir, 'packages', 'demo', 'README.md'),
      '# Demo README\n\nDeveloper docs.',
    );
    await writeFile(
      join(rootDir, 'packages', 'demo', 'src', 'workbench.ts'),
      'export default { packageName: "@happyvertical/smrt-demo" };',
    );

    const specialist = await buildPackageSpecialistContext({
      rootDir,
      package: 'demo',
    });

    expect(specialist.selectedPackage.name).toBe('@happyvertical/smrt-demo');
    expect(specialist.promptBundle.title).toBe(
      'SMRT package specialist: @happyvertical/smrt-demo',
    );
    expect(specialist.sourceFiles).toEqual(
      expect.arrayContaining([
        'packages/demo/AGENTS.md',
        'packages/demo/README.md',
        'packages/demo/src/workbench.ts',
        'packages/demo/src/manifest/manifest.json',
      ]),
    );
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
          sensitiveFieldsExcluded: true,
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
                {
                  name: 'attempts',
                  type: 'integer',
                  default: 0,
                  constraints: { min: 0, max: 3 },
                  readonly: true,
                },
                {
                  name: 'secretId',
                  type: 'foreignKey',
                  related: 'Secret',
                  sensitive: true,
                },
                {
                  name: 'legacySecretId',
                  type: 'foreignKey',
                  related: 'LegacySecret',
                  _meta: { sensitive: true },
                },
                {
                  name: 'privateTenantId',
                  type: 'foreignKey',
                  related: 'Tenant',
                  sensitive: true,
                },
                {
                  name: 'apiTokenID',
                  type: 'text',
                  _meta: { sensitive: true },
                },
              ],
              relationships: [
                {
                  name: 'profileId',
                  type: 'crossPackageRef',
                  related: '@happyvertical/smrt-profiles:Profile',
                  columnType: 'UUID',
                },
                {
                  name: 'secretId',
                  type: 'foreignKey',
                  related: 'Secret',
                  sensitive: true,
                },
                {
                  name: 'legacySecretId',
                  type: 'foreignKey',
                  related: 'LegacySecret',
                  _meta: { sensitive: true },
                },
              ],
              methods: ['sync'],
              methodSignatures: [
                {
                  name: 'sync',
                  async: true,
                  params: ['force?: boolean'],
                  returns: 'Promise<void>',
                },
              ],
              tenant: {
                scoped: true,
                mode: 'required',
                field: 'privateTenantId',
              },
              tableStrategy: 'cti',
              conflictColumns: [
                'tenant_id',
                'profile_id',
                'secret_id',
                'legacy_secret_id',
                'private_tenant_id',
                'api_token_i_d',
              ],
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
            {
              name: 'LegacyArtifact',
              qualifiedName: '@happyvertical/smrt-demo:LegacyArtifact',
              collection: 'legacy_artifacts',
              fields: [],
              relationships: [],
              methods: [],
              surfaces: [],
              relationshipFeatures: [],
              tags: [],
              risks: [],
            },
            {
              name: 'UnscopedArtifact',
              qualifiedName: '@happyvertical/smrt-demo:UnscopedArtifact',
              collection: 'unscoped_artifacts',
              fields: [],
              relationships: [],
              methods: [],
              tenant: { scoped: false },
              surfaces: [],
              relationshipFeatures: [],
              tags: [],
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
      'LegacyArtifact',
      'UnscopedArtifact',
    ]);
    expect(demo?.mcpTools.map((tool) => tool.name)).toEqual([
      'artifactdemo_sync',
    ]);
    expect(demo?.agentDoc).toContain('Artifact guidance');
    expect(demo?.objects[0]).toMatchObject({
      tenant: { scoped: true, mode: 'required' },
      tableStrategy: 'cti',
      conflictColumns: ['tenant_id', 'profile_id'],
      methodSignatures: [
        {
          name: 'sync',
          async: true,
          params: ['force?: boolean'],
          returns: 'Promise<void>',
        },
      ],
    });
    expect(demo?.objects[0].fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'attempts',
          default: 0,
          constraints: { min: 0, max: 3 },
          readonly: true,
        }),
      ]),
    );
    expect(demo?.objects[0].fields.map((field) => field.name)).not.toEqual(
      expect.arrayContaining(['secretId', 'legacySecretId', 'apiTokenID']),
    );
    expect(
      demo?.objects[0].relationships.map((field) => field.name),
    ).not.toEqual(
      expect.arrayContaining(['secretId', 'legacySecretId', 'apiTokenID']),
    );
    expect(JSON.stringify(demo)).not.toMatch(
      /secretId|legacySecretId|privateTenantId|apiTokenID|secret_id|legacy_secret_id|private_tenant_id|api_token_i_d/,
    );
    expect(JSON.stringify(demo?.domainKnowledge)).not.toMatch(
      /secretId|legacySecretId|privateTenantId|apiTokenID|secret_id|legacy_secret_id|private_tenant_id|api_token_i_d/,
    );
    expect(demo?.objects[1]).toMatchObject({
      className: 'LegacyArtifact',
      fields: [],
      methods: [],
    });
    expect(demo?.objects[1].tenant).toBeUndefined();
    expect(demo?.objects[2].tenant).toEqual({ scoped: false });

    const architecture = await buildArchitectureContext({
      rootDir,
      package: '@happyvertical/smrt-demo',
      detail: 'full',
    });
    expect(architecture.promptBundle.contextMarkdown).toContain(
      '@happyvertical/smrt-demo:UnscopedArtifact — tenant unscoped',
    );
  });

  it('uses the raw manifest to sanitize marker-less legacy artifacts', async () => {
    await mkdir(join(rootDir, 'packages', 'demo', '.smrt'), {
      recursive: true,
    });
    await writeFile(
      join(rootDir, 'packages', 'demo', '.smrt', 'smrt-knowledge.json'),
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        packageName: '@happyvertical/smrt-demo',
        sourceHashes: {},
        exports: [],
        dependencies: {},
        smrtDependencies: [],
        sdkDependencies: [],
        tags: [],
        risks: [],
        objects: [
          {
            name: 'Demo',
            qualifiedName: '@happyvertical/smrt-demo:Demo',
            fields: [
              { name: 'ownerId', type: 'foreignKey', related: 'Owner' },
              { name: 'secretId', type: 'foreignKey', related: 'Secret' },
              {
                name: 'legacySecretId',
                type: 'foreignKey',
                related: 'LegacySecret',
              },
              { name: 'apiTokenID', type: 'text' },
            ],
            relationships: [
              { name: 'ownerId', type: 'foreignKey', related: 'Owner' },
              { name: 'secretId', type: 'foreignKey', related: 'Secret' },
              {
                name: 'legacySecretId',
                type: 'foreignKey',
                related: 'LegacySecret',
              },
            ],
            methods: [],
            tenant: { scoped: true, mode: 'optional', field: 'workspaceId' },
            conflictColumns: [
              'workspace_id',
              'code',
              'secret_id',
              'legacy_secret_id',
              'api_token_i_d',
            ],
            surfaces: [],
            relationshipFeatures: [],
            tags: [],
            risks: [],
          },
          {
            name: 'DemoLinks',
            qualifiedName: '@happyvertical/smrt-demo:DemoLinks',
            fields: [
              { name: 'leftId', type: 'foreignKey', related: 'Left' },
              { name: 'rightId', type: 'foreignKey', related: 'Right' },
              {
                name: 'privateTenantId',
                type: 'foreignKey',
                related: 'Tenant',
              },
            ],
            relationships: [
              { name: 'leftId', type: 'foreignKey', related: 'Left' },
              { name: 'rightId', type: 'foreignKey', related: 'Right' },
              {
                name: 'privateTenantId',
                type: 'foreignKey',
                related: 'Tenant',
              },
            ],
            methods: [],
            tenant: {
              scoped: true,
              mode: 'required',
              field: 'privateTenantId',
            },
            conflictColumns: ['left_id', 'right_id', 'private_tenant_id'],
            surfaces: [],
            relationshipFeatures: [],
            tags: [],
            risks: [],
          },
        ],
        surfaces: [],
        prompts: [],
        relationshipsV2: {
          foreignKeyFields: 0,
          crossPackageRefFields: 0,
          junctionCollections: 0,
          hierarchicalObjects: 0,
          polymorphicAssociations: 0,
          uuidColumns: 0,
        },
      }),
    );

    const index = await buildKnowledgeIndex({ rootDir });
    const pkg = index.packages.find(
      (candidate) => candidate.name === '@happyvertical/smrt-demo',
    );
    const demo = pkg?.objects.find((object) => object.className === 'Demo');
    const links = pkg?.objects.find(
      (object) => object.className === 'DemoLinks',
    );

    expect(demo?.fields.map((field) => field.name)).toEqual(['ownerId']);
    expect(demo?.relationships.map((field) => field.name)).toEqual(['ownerId']);
    expect(demo?.conflictColumns).toEqual(['workspace_id', 'code']);
    expect(links).toMatchObject({
      tenant: { scoped: true, mode: 'required' },
      conflictColumns: ['left_id', 'right_id'],
    });
    const serialized = JSON.stringify(pkg);
    expect(serialized).not.toMatch(
      /secretId|legacySecretId|apiTokenID|privateTenantId|secret_id|legacy_secret_id|api_token_i_d|private_tenant_id/,
    );

    const architecture = await buildArchitectureContext({
      rootDir,
      package: '@happyvertical/smrt-demo',
      detail: 'full',
    });
    expect(architecture.promptBundle.contextMarkdown).not.toMatch(
      /secretId|legacySecretId|apiTokenID|privateTenantId/,
    );
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
    expect(result.promptBundle.contextMarkdown).not.toContain(
      'Object structural facts',
    );
  });

  it('renders structural facts in full review and architecture bundles', async () => {
    const review = await buildReviewContext({
      rootDir,
      changedFiles: ['packages/demo/src/demo.ts'],
      detail: 'full',
    });
    const architecture = await buildArchitectureContext({
      rootDir,
      package: '@happyvertical/smrt-demo',
      detail: 'full',
    });
    const smrtReviewResult = await smrtReview({
      rootDir,
      changedFiles: ['packages/demo/src/demo.ts'],
      detail: 'full',
      mode: 'prompt-bundle',
    });

    for (const markdown of [
      review.promptBundle.contextMarkdown,
      architecture.promptBundle.contextMarkdown,
      smrtReviewResult.promptBundle?.contextMarkdown ?? '',
    ]) {
      expect(markdown).toContain('Object structural facts');
      expect(markdown).toContain(
        'tenant optional via workspaceId; table strategy sti; conflict columns workspace_id, code',
      );
      expect(markdown).toContain(
        'field attempts: integer (default 0; constraints min=0, max=5; readonly)',
      );
      expect(markdown).toContain(
        'method async sync(force?: boolean): Promise<void>',
      );
      expect(markdown).not.toContain('secretId');
      expect(markdown).not.toContain('legacySecretId');
      expect(markdown).not.toContain('apiTokenID');
      expect(markdown).not.toContain('api_token_i_d');
    }
  });

  it('embeds every linked module doc when nothing narrows the request (#2108)', async () => {
    await writeModuleDocs(rootDir);

    const result = await buildArchitectureContext({
      rootDir,
      package: '@happyvertical/smrt-demo',
      detail: 'full',
    });
    const markdown = result.promptBundle.contextMarkdown;

    // A package selector is not a module selector — the moved prose is not
    // regenerable, so a bare package request must not silently drop any of it.
    expect(markdown).toContain('agents/payouts.md, agents/crm.md');
    expect(markdown).toContain('claimForPayout never double-owns');
    expect(markdown).toContain('Leads and pipelines');
    expect(markdown).not.toContain('Module docs not loaded');
  });

  it('narrows embedded module docs to the changed module, listing the rest', async () => {
    await writeModuleDocs(rootDir);

    const result = await buildReviewContext({
      rootDir,
      changedFiles: ['packages/demo/src/payouts/claim.ts'],
      detail: 'full',
    });
    const markdown = result.promptBundle.contextMarkdown;

    expect(markdown).toContain('claimForPayout never double-owns');
    expect(markdown).not.toContain('Leads and pipelines');
    expect(markdown).toContain(
      'Module docs not loaded for this request (read on demand): packages/demo/agents/crm.md',
    );
  });

  it('falls open to every module doc when hints match no module', async () => {
    await writeModuleDocs(rootDir);

    const result = await buildReviewContext({
      rootDir,
      changedFiles: ['packages/demo/src/unrelated.ts'],
      focus: 'nothing here names a module',
      detail: 'full',
    });
    const markdown = result.promptBundle.contextMarkdown;

    expect(markdown).toContain('claimForPayout never double-owns');
    expect(markdown).toContain('Leads and pipelines');
  });

  it('flags a changed module doc as an authored-expertise change', async () => {
    await writeModuleDocs(rootDir);

    const result = await smrtReview({
      rootDir,
      changedFiles: ['packages/demo/agents/payouts.md'],
      mode: 'findings',
    });

    expect(result.deterministicFindings.map((issue) => issue.code)).toContain(
      'agent-expertise-review',
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

/**
 * Split the demo package's AGENTS.md by module the way #2108 splits an
 * oversized real one: sibling `agents/<module>.md` files linked from a Modules
 * table, never nested AGENTS.md files.
 */
async function writeModuleDocs(rootDir: string): Promise<void> {
  const pkgDir = join(rootDir, 'packages', 'demo');
  await mkdir(join(pkgDir, 'agents'), { recursive: true });
  await writeFile(
    join(pkgDir, 'agents', 'payouts.md'),
    '# demo/payouts\n\n`claimForPayout never double-owns` a row.\n',
  );
  await writeFile(
    join(pkgDir, 'agents', 'crm.md'),
    '# demo/crm\n\nLeads and pipelines.\n',
  );
  await writeFile(
    join(pkgDir, 'AGENTS.md'),
    [
      '# Demo',
      '',
      'Package-specific expert guidance.',
      '',
      '## Modules',
      '',
      '| Module | Module doc |',
      '|---|---|',
      '| payouts | [agents/payouts.md](agents/payouts.md) |',
      '| crm | [agents/crm.md](agents/crm.md) |',
    ].join('\n'),
  );
}

/**
 * Discovery regressions for #2143: the index used to hardcode `<root>/packages`,
 * so every SMRT object in an `apps/*` package was invisible and the planning
 * tools returned confident all-zero context with no diagnostic.
 */
describe('workspace discovery', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = join(tmpdir(), `smrt-discovery-${Date.now()}-${counter++}`);
    await mkdir(rootDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('discovers objects in an apps/*-only workspace', async () => {
    await writeWorkspaceYaml(rootDir, ["'apps/*'"]);
    await writeManifestPackage(rootDir, 'apps/web', '@acme/web', ['Invoice']);

    const index = await buildKnowledgeIndex({ rootDir });

    expect(index.coverage.workspaceGlobs).toEqual(['apps/*']);
    expect(index.coverage.workspaceGlobSource).toBe('pnpm-workspace.yaml');
    expect(index.coverage.packageDirs).toContain('apps/web');
    expect(
      index.packages.find((pkg) => pkg.name === '@acme/web')?.objects,
    ).toHaveLength(1);
    expect(index.relationshipsV2.foreignKeyFields).toBe(1);
    expect(index.diagnostics).toHaveLength(0);
  });

  it('discovers objects across a mixed apps/* + packages/* workspace', async () => {
    await writeWorkspaceYaml(rootDir, ["'apps/*'", "'packages/*'"]);
    await writeManifestPackage(rootDir, 'apps/web', '@acme/web', ['Invoice']);
    await writeManifestPackage(rootDir, 'packages/core', '@acme/core', [
      'Ledger',
    ]);

    const index = await buildKnowledgeIndex({ rootDir });

    expect(index.coverage.packageDirs).toEqual(
      expect.arrayContaining(['apps/web', 'packages/core']),
    );
    expect(index.relationshipsV2.foreignKeyFields).toBe(2);
    expect(index.coverage.packagesWithObjects).toEqual(
      expect.arrayContaining([
        '@acme/core (1, manifest)',
        '@acme/web (1, manifest)',
      ]),
    );
  });

  it('honors negated globs and literal nested package paths', async () => {
    await writeWorkspaceYaml(rootDir, [
      "'packages/*'",
      "'tools/build/host'",
      "'!packages/fixtures'",
    ]);
    await writeManifestPackage(rootDir, 'packages/core', '@acme/core', [
      'Ledger',
    ]);
    await writeManifestPackage(rootDir, 'packages/fixtures', '@acme/fixtures', [
      'Fixture',
    ]);
    await writeManifestPackage(rootDir, 'tools/build/host', '@acme/host', [
      'Host',
    ]);

    const index = await buildKnowledgeIndex({ rootDir });
    const names = index.packages.map((pkg) => pkg.name);

    expect(names).toContain('@acme/core');
    expect(names).toContain('@acme/host');
    expect(names).not.toContain('@acme/fixtures');
  });

  it('reads workspace globs from package.json when pnpm-workspace.yaml is absent', async () => {
    await writeFile(
      join(rootDir, 'package.json'),
      JSON.stringify({ name: 'acme-root', workspaces: ['apps/*'] }, null, 2),
    );
    await writeManifestPackage(rootDir, 'apps/web', '@acme/web', ['Invoice']);

    const index = await buildKnowledgeIndex({ rootDir });

    expect(index.coverage.workspaceGlobSource).toBe('package.json#workspaces');
    expect(index.coverage.packageDirs).toContain('apps/web');
  });

  it('indexes a single-package repository as its own package', async () => {
    await writeManifestPackage(rootDir, '.', '@acme/solo', ['Invoice']);

    const index = await buildKnowledgeIndex({ rootDir });
    const solo = index.packages.find((pkg) => pkg.name === '@acme/solo');

    expect(solo?.isWorkspaceRoot).toBe(true);
    expect(solo?.objects).toHaveLength(1);
    expect(index.relationshipsV2.foreignKeyFields).toBe(1);
  });

  it('resolves objects from source when no artifact exists', async () => {
    await writeWorkspaceYaml(rootDir, ["'apps/*'"]);
    const pkgDir = join(rootDir, 'apps', 'web');
    await mkdir(join(pkgDir, 'src'), { recursive: true });
    await writeFile(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@acme/web', version: '1.0.0' }, null, 2),
    );
    await writeFile(
      join(pkgDir, 'src', 'models.ts'),
      [
        "import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';",
        '',
        "@smrt({ tableName: 'invoices' })",
        'export class Invoice extends SmrtObject {',
        "  @foreignKey('Customer')",
        "  customerId: string = '';",
        "  reference: string = '';",
        '}',
      ].join('\n'),
    );

    const index = await buildKnowledgeIndex({ rootDir });
    const web = index.packages.find((pkg) => pkg.name === '@acme/web');

    expect(web?.objectSource).toBe('scanner');
    expect(web?.objects.map((object) => object.className)).toEqual(['Invoice']);
    expect(index.relationshipsV2.foreignKeyFields).toBe(1);
  });

  it('rejects aggregate manifest objects owned by other packages', async () => {
    await writeWorkspaceYaml(rootDir, ["'packages/*'"]);
    const pkgDir = join(rootDir, 'packages', 'cli');
    await mkdir(join(pkgDir, '.smrt'), { recursive: true });
    await writeFile(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@acme/cli', version: '1.0.0' }, null, 2),
    );
    await writeFile(
      join(pkgDir, '.smrt', 'manifest.json'),
      JSON.stringify({
        version: '1',
        objects: {
          '@acme/cli:Own': {
            className: 'Own',
            qualifiedName: '@acme/cli:Own',
            collection: 'owns',
            fields: { ownerId: { type: 'foreignKey', related: 'Owner' } },
          },
          '@acme/other:Foreign': {
            className: 'Foreign',
            qualifiedName: '@acme/other:Foreign',
            collection: 'foreigns',
            fields: {
              aId: { type: 'foreignKey', related: 'A' },
              bId: { type: 'foreignKey', related: 'B' },
            },
          },
          '@acme/third:AlsoForeign': {
            className: 'AlsoForeign',
            packageName: '@acme/third',
            collection: 'also_foreigns',
            fields: { cId: { type: 'foreignKey', related: 'C' } },
          },
        },
      }),
    );

    const index = await buildKnowledgeIndex({ rootDir });
    const cli = index.packages.find((pkg) => pkg.name === '@acme/cli');

    // Only the owned object counts; the aggregate would otherwise report 4.
    expect(cli?.objects.map((object) => object.className)).toEqual(['Own']);
    expect(index.relationshipsV2.foreignKeyFields).toBe(1);
    expect(cli?.objectSourceReason).toContain('rejected 2');
    expect(index.diagnostics.map((entry) => entry.code)).toContain(
      'partial-foreign-manifest-objects',
    );
  });

  it('reports an error diagnostic instead of a zeroed bundle when nothing is discovered', async () => {
    await writeWorkspaceYaml(rootDir, ["'apps/*'"]);
    await mkdir(join(rootDir, 'apps', 'web'), { recursive: true });
    await writeFile(
      join(rootDir, 'apps', 'web', 'package.json'),
      JSON.stringify({ name: '@acme/web', version: '1.0.0' }, null, 2),
    );

    const index = await buildKnowledgeIndex({ rootDir });
    const zero = index.diagnostics.find(
      (entry) => entry.code === 'no-smrt-objects-discovered',
    );

    expect(zero?.severity).toBe('error');
    expect(zero?.message).toContain(rootDir);
    expect(zero?.message).toContain('apps/*');
    expect(zero?.remedy).toContain('pnpm build');
    expect(zero?.checkedPaths).toEqual(
      expect.arrayContaining(['apps/web/.smrt/manifest.json']),
    );

    // The architecture tool must lead with the failure, not a generic sketch.
    const architecture = await smrtArchitecture({ rootDir, idea: 'invoicing' });
    expect(architecture.diagnostics.map((entry) => entry.code)).toContain(
      'no-smrt-objects-discovered',
    );
    expect(architecture.recommendations.objectModelSketch.join('\n')).toContain(
      'No object model could be derived',
    );
    expect(architecture.promptBundle.contextMarkdown).toContain(
      '[ERROR] no-smrt-objects-discovered',
    );

    const review = await smrtReview({ rootDir, mode: 'both' });
    expect(review.diagnostics.map((entry) => entry.code)).toContain(
      'no-smrt-objects-discovered',
    );
  });

  it('counts one table once when a consuming package restates its dependency', async () => {
    await writeWorkspaceYaml(rootDir, ["'apps/*'", "'packages/*'"]);
    // A consuming app's stale artifact re-qualifies its dependency's objects
    // under its own package name, which name-prefix ownership cannot detect.
    await writeManifestPackage(rootDir, 'packages/work', '@acme/work', [
      'Plan',
    ]);
    await writeManifestPackage(rootDir, 'apps/web', '@acme/web', ['Plan'], {
      '@acme/work': 'workspace:*',
    });

    const index = await buildKnowledgeIndex({ rootDir });

    expect(index.relationshipsV2.foreignKeyFields).toBe(1);
    expect(index.diagnostics.map((entry) => entry.code)).toContain(
      'duplicate-object-identity',
    );
  });

  it('keeps same-named objects from unrelated packages as distinct', async () => {
    await writeWorkspaceYaml(rootDir, ["'packages/*'"]);
    // Two unrelated packages each declaring their own `Account` is a real
    // collision, not a double count — both must keep contributing fields.
    await writeManifestPackage(rootDir, 'packages/messages', '@acme/messages', [
      'Account',
    ]);
    await writeManifestPackage(rootDir, 'packages/ledgers', '@acme/ledgers', [
      'Account',
    ]);

    const index = await buildKnowledgeIndex({ rootDir });

    expect(index.relationshipsV2.foreignKeyFields).toBe(2);
    expect(index.diagnostics.map((entry) => entry.code)).not.toContain(
      'duplicate-object-identity',
    );
  });

  it('collapses one table across two independent consumers of a shared dependency', async () => {
    await writeWorkspaceYaml(rootDir, ["'apps/*'", "'packages/*'"]);
    // Neither consumer has an edge to the other, so a greedy pairwise collapse
    // would keep both restatements and double-count the shared table.
    await writeManifestPackage(rootDir, 'packages/work', '@acme/work', [
      'Plan',
    ]);
    await writeManifestPackage(rootDir, 'apps/web1', '@acme/web1', ['Plan'], {
      '@acme/work': 'workspace:*',
    });
    await writeManifestPackage(rootDir, 'apps/web2', '@acme/web2', ['Plan'], {
      '@acme/work': 'workspace:*',
    });

    const index = await buildKnowledgeIndex({ rootDir });

    expect(index.relationshipsV2.foreignKeyFields).toBe(1);
  });

  it('keeps the dependency-owned copy rather than the consumer restatement', async () => {
    await writeWorkspaceYaml(rootDir, ["'apps/*'", "'packages/*'"]);
    // The owner declares two foreignKey fields; the consumer's stale copy has
    // one. Picking the owner is what keeps the facts canonical.
    await writeManifestPackage(
      rootDir,
      'packages/work',
      '@acme/work',
      [],
      {},
      {
        '@acme/work:Plan': {
          className: 'Plan',
          qualifiedName: '@acme/work:Plan',
          collection: 'plans',
          fields: {
            ownerId: { type: 'foreignKey', related: 'Owner' },
            teamId: { type: 'foreignKey', related: 'Team' },
          },
          schema: { tableName: 'plans' },
        },
      },
    );
    await writeManifestPackage(rootDir, 'apps/web', '@acme/web', ['Plan'], {
      '@acme/work': 'workspace:*',
    });

    const index = await buildKnowledgeIndex({ rootDir });

    expect(index.relationshipsV2.foreignKeyFields).toBe(2);
  });

  it('scans root-owned sources while excluding member packages', async () => {
    await writeWorkspaceYaml(rootDir, ["'packages/*'"]);
    await writeFile(
      join(rootDir, 'package.json'),
      JSON.stringify({ name: '@acme/root', version: '1.0.0' }, null, 2),
    );
    await mkdir(join(rootDir, 'src'), { recursive: true });
    await writeFile(
      join(rootDir, 'src', 'root-model.ts'),
      [
        "import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';",
        '',
        "@smrt({ tableName: 'root_things' })",
        'export class RootThing extends SmrtObject {',
        "  @foreignKey('Owner')",
        "  ownerId: string = '';",
        '}',
      ].join('\n'),
    );
    await writeManifestPackage(rootDir, 'packages/member', '@acme/member', [
      'Member',
    ]);

    const index = await buildKnowledgeIndex({ rootDir });
    const root = index.packages.find((pkg) => pkg.name === '@acme/root');

    // The root owns RootThing and must NOT absorb the member's objects.
    expect(root?.objectSource).toBe('scanner');
    expect(root?.objects.map((object) => object.className)).toEqual([
      'RootThing',
    ]);
    expect(index.relationshipsV2.foreignKeyFields).toBe(2);
  });

  it('finds models nested deeper than a shallow probe would reach', async () => {
    await writeWorkspaceYaml(rootDir, ["'packages/*'"]);
    const deep = join(
      rootDir,
      'packages',
      'billing',
      'src',
      'features',
      'billing',
      'models',
      'internal',
    );
    await mkdir(deep, { recursive: true });
    await writeFile(
      join(rootDir, 'packages', 'billing', 'package.json'),
      JSON.stringify({ name: '@acme/billing', version: '1.0.0' }, null, 2),
    );
    await writeFile(
      join(deep, 'Invoice.ts'),
      [
        "import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';",
        '',
        "@smrt({ tableName: 'invoices' })",
        'export class Invoice extends SmrtObject {',
        "  @foreignKey('Customer')",
        "  customerId: string = '';",
        '}',
      ].join('\n'),
    );

    const index = await buildKnowledgeIndex({ rootDir });
    const billing = index.packages.find((pkg) => pkg.name === '@acme/billing');

    expect(billing?.objectSource).toBe('scanner');
    expect(billing?.objects.map((object) => object.className)).toEqual([
      'Invoice',
    ]);
  });

  it('matches a globstar against zero directory segments', async () => {
    await writeWorkspaceYaml(rootDir, ["'apps/**/host'"]);
    await writeManifestPackage(rootDir, 'apps/host', '@acme/shallow', ['A']);
    await writeManifestPackage(rootDir, 'apps/nested/host', '@acme/deep', [
      'B',
    ]);

    const index = await buildKnowledgeIndex({ rootDir });
    const names = index.packages.map((pkg) => pkg.name);

    expect(names).toContain('@acme/shallow');
    expect(names).toContain('@acme/deep');
  });

  it('discovers a valid globstar package deeper than six directory levels', async () => {
    await writeWorkspaceYaml(rootDir, ["'apps/**/host'"]);
    const deepPackage = 'apps/a/b/c/d/e/f/g/h/host';
    await writeManifestPackage(rootDir, deepPackage, '@acme/very-deep', [
      'DeepModel',
    ]);

    const index = await buildKnowledgeIndex({ rootDir });

    expect(index.coverage.packageDirs).toContain(deepPackage);
    expect(
      index.packages.find((pkg) => pkg.name === '@acme/very-deep')?.objects,
    ).toHaveLength(1);
  });

  it('rejects parent-directory workspace globs at the project boundary', async () => {
    const outsideDir = join(dirname(rootDir), `${basename(rootDir)}-outside`);
    try {
      await writeWorkspaceYaml(rootDir, [`'../${basename(outsideDir)}'`]);
      await writeManifestPackage(outsideDir, '.', '@acme/outside', [
        'OutsideModel',
      ]);

      const index = await buildKnowledgeIndex({ rootDir });

      expect(index.packages.map((pkg) => pkg.name)).not.toContain(
        '@acme/outside',
      );
      expect(index.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: 'error',
            code: 'unsafe-workspace-glob',
          }),
        ]),
      );
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('rejects absolute and unsafe negated workspace globs', async () => {
    await writeWorkspaceYaml(rootDir, [
      "'packages/*'",
      "'/tmp/outside'",
      "'C:/outside'",
      "'!../outside'",
    ]);
    await writeManifestPackage(rootDir, 'packages/core', '@acme/core', [
      'CoreModel',
    ]);

    const index = await buildKnowledgeIndex({ rootDir });

    expect(index.packages.map((pkg) => pkg.name)).toContain('@acme/core');
    expect(
      index.diagnostics.filter(
        (diagnostic) => diagnostic.code === 'unsafe-workspace-glob',
      ),
    ).toHaveLength(3);
  });

  it('rejects a workspace symlink whose real path escapes the root', async () => {
    const outsideDir = join(
      dirname(rootDir),
      `${basename(rootDir)}-symlink-target`,
    );
    try {
      await writeWorkspaceYaml(rootDir, ["'packages/outside-link'"]);
      await writeManifestPackage(outsideDir, '.', '@acme/outside', [
        'OutsideModel',
      ]);
      await mkdir(join(rootDir, 'packages'), { recursive: true });
      await symlink(
        outsideDir,
        join(rootDir, 'packages', 'outside-link'),
        'dir',
      );

      const index = await buildKnowledgeIndex({ rootDir });

      expect(index.packages.map((pkg) => pkg.name)).not.toContain(
        '@acme/outside',
      );
      expect(index.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: 'error',
            code: 'workspace-glob-root-escape',
          }),
        ]),
      );
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it('shares the traversal budget across multiple positive globs', async () => {
    await writeWorkspaceYaml(rootDir, ["'**/**'", "'**/**'"]);
    const segments = Array.from({ length: 100 }, (_, index) => `d${index}`);
    await writeManifestPackage(rootDir, join(...segments), '@acme/amplified', [
      'AmplifiedModel',
    ]);

    const index = await buildKnowledgeIndex({ rootDir });

    expect(index.packages).toHaveLength(0);
    expect(index.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'workspace-glob-expansion-limit',
        }),
      ]),
    );
  });

  it('fails before package reads when the package cardinality cap is exceeded', async () => {
    await writeWorkspaceYaml(rootDir, ["'packages/*'"]);
    for (let index = 0; index < 513; index += 1) {
      const packageDir = join(rootDir, 'packages', `pkg-${index}`);
      await mkdir(packageDir, { recursive: true });
      await writeFile(
        join(packageDir, 'package.json'),
        JSON.stringify({ name: `@acme/pkg-${index}`, version: '1.0.0' }),
      );
    }

    const index = await buildKnowledgeIndex({ rootDir });

    expect(index.packages).toHaveLength(0);
    expect(index.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'workspace-package-limit',
        }),
      ]),
    );
  });

  it('does not report a discovery failure when a scope filter excludes the model', async () => {
    await writeWorkspaceYaml(rootDir, ["'packages/*'"]);
    await writeManifestPackage(rootDir, 'packages/core', '@acme/core', [
      'Ledger',
    ]);

    // Scoping to SDK packages leaves zero objects in the scoped set, but the
    // workspace model was discovered fine — that must not read as a failure.
    const scoped = await buildKnowledgeIndex({ rootDir, scope: 'sdk' });

    expect(scoped.packages).toHaveLength(0);
    expect(scoped.diagnostics.map((entry) => entry.code)).not.toContain(
      'no-smrt-objects-discovered',
    );
    expect(scoped.coverage.packagesWithObjects).toEqual(
      expect.arrayContaining(['@acme/core (1, manifest)']),
    );
  });

  it('still validates docs and packaging for a single-package root', async () => {
    // The sole publishable package IS the workspace root here, so exempting
    // every root would silently turn the freshness gate into a no-op.
    await writeManifestPackage(rootDir, '.', '@acme/solo', ['Invoice']);

    const result = await checkKnowledgeFreshness({ rootDir });
    const codes = result.issues.map((issue) => issue.code);

    expect(result.ok).toBe(false);
    expect(codes).toContain('missing-agents-md');
    expect(codes).toContain('package-files-missing-agents');
  });

  it('exempts a monorepo root from publishable-package rules', async () => {
    await writeWorkspaceYaml(rootDir, ["'packages/*'"]);
    await writeFile(
      join(rootDir, 'package.json'),
      JSON.stringify({ name: '@acme/root', version: '1.0.0' }, null, 2),
    );
    await writeManifestPackage(rootDir, 'packages/core', '@acme/core', [
      'Ledger',
    ]);
    await writeFile(join(rootDir, 'packages', 'core', 'AGENTS.md'), '# core\n');
    await writeFile(
      join(rootDir, 'packages', 'core', 'CLAUDE.md'),
      '@AGENTS.md\n',
    );

    const result = await checkKnowledgeFreshness({ rootDir });

    expect(
      result.issues.filter((issue) => issue.packageName === '@acme/root'),
    ).toEqual([]);
  });

  it('keeps prompt bundles small by default and embeds docs only on request', async () => {
    await writeWorkspaceYaml(rootDir, ["'packages/*'"]);
    await writeManifestPackage(rootDir, 'packages/core', '@acme/core', [
      'Ledger',
    ]);
    await writeFile(
      join(rootDir, 'packages', 'core', 'AGENTS.md'),
      `# core\n\n${'Authored expertise prose. '.repeat(400)}`,
    );

    const summary = await buildArchitectureContext({ rootDir, idea: 'ledger' });
    const full = await buildArchitectureContext({
      rootDir,
      idea: 'ledger',
      detail: 'full',
    });

    expect(summary.promptBundle.contextMarkdown).not.toContain(
      'Authored expertise prose.',
    );
    expect(summary.promptBundle.contextMarkdown).toContain(
      'packages/core/AGENTS.md',
    );
    expect(full.promptBundle.contextMarkdown).toContain(
      'Authored expertise prose.',
    );
    expect(summary.promptBundle.contextMarkdown.length).toBeLessThan(
      full.promptBundle.contextMarkdown.length / 2,
    );
  });

  it('keeps root-package doc paths project-relative', async () => {
    // The root's relativeDirectory is '', so naive interpolation emitted
    // `/AGENTS.md` — an absolute filesystem path — and sent summary callers to
    // the filesystem root instead of the project (#2143).
    await writeManifestPackage(rootDir, '.', '@acme/solo', ['Ledger']);
    await writeFile(
      join(rootDir, 'AGENTS.md'),
      `# solo\n\n${'Authored expertise prose. '.repeat(400)}`,
    );
    await mkdir(join(rootDir, 'agents'), { recursive: true });
    await writeFile(join(rootDir, 'agents', 'billing.md'), '# billing\n');

    const summary = await buildArchitectureContext({ rootDir, idea: 'ledger' });
    const markdown = summary.promptBundle.contextMarkdown;

    expect(markdown).toContain('AGENTS.md');
    expect(markdown).not.toContain('/AGENTS.md');
    expect(markdown).not.toContain('/agents/billing.md');
  });

  it('selects the root package for its own changed files', async () => {
    // A root package matched nothing, because every changed path was compared
    // against a leading '/'. That returned the silently empty context #2143 is
    // about, for exactly the single-package layout it added.
    await writeManifestPackage(rootDir, '.', '@acme/solo', ['Ledger']);
    await writeFile(join(rootDir, 'AGENTS.md'), '# solo\n');

    const review = await buildReviewContext({
      rootDir,
      changedFiles: ['src/models/Ledger.ts'],
    });

    expect(review.selectedPackages.map((pkg) => pkg.name)).toContain(
      '@acme/solo',
    );
  });

  it('does not let a workspace root absorb a member package file', async () => {
    await writeWorkspaceYaml(rootDir, ["'packages/*'"]);
    await writeFile(
      join(rootDir, 'package.json'),
      JSON.stringify({ name: '@acme/root', version: '1.0.0' }, null, 2),
    );
    await writeManifestPackage(rootDir, 'packages/core', '@acme/core', [
      'Ledger',
    ]);

    const review = await buildReviewContext({
      rootDir,
      changedFiles: ['packages/core/src/Ledger.ts'],
    });

    expect(review.selectedPackages.map((pkg) => pkg.name)).toEqual([
      '@acme/core',
    ]);
  });

  it('exempts a nested workspace member from canonical doc rules', async () => {
    // Instruction chains are additive, so a nested AGENTS.md is prohibited —
    // demanding one here would require exactly the forbidden file.
    await writeWorkspaceYaml(rootDir, ["'packages/*'", "'packages/ui/host'"]);
    await writeManifestPackage(rootDir, 'packages/ui', '@acme/ui', ['Widget']);
    await writeFile(join(rootDir, 'packages', 'ui', 'AGENTS.md'), '# ui\n');
    await writeFile(
      join(rootDir, 'packages', 'ui', 'CLAUDE.md'),
      '@AGENTS.md\n',
    );
    await mkdir(join(rootDir, 'packages', 'ui', 'host'), { recursive: true });
    await writeFile(
      join(rootDir, 'packages', 'ui', 'host', 'package.json'),
      JSON.stringify(
        { name: '@acme/ui-host', version: '0.0.0', private: true },
        null,
        2,
      ),
    );

    const result = await checkKnowledgeFreshness({ rootDir });

    expect(
      result.issues.filter((issue) => issue.packageName === '@acme/ui-host'),
    ).toEqual([]);
  });

  it('reports a nested AGENTS.md instead of accepting it', async () => {
    await writeWorkspaceYaml(rootDir, ["'packages/*'", "'packages/ui/host'"]);
    await writeManifestPackage(rootDir, 'packages/ui', '@acme/ui', ['Widget']);
    await writeFile(join(rootDir, 'packages', 'ui', 'AGENTS.md'), '# ui\n');
    await writeFile(
      join(rootDir, 'packages', 'ui', 'CLAUDE.md'),
      '@AGENTS.md\n',
    );
    await mkdir(join(rootDir, 'packages', 'ui', 'host'), { recursive: true });
    await writeFile(
      join(rootDir, 'packages', 'ui', 'host', 'package.json'),
      JSON.stringify(
        { name: '@acme/ui-host', version: '0.0.0', private: true },
        null,
        2,
      ),
    );
    await writeFile(
      join(rootDir, 'packages', 'ui', 'host', 'AGENTS.md'),
      '# host\n',
    );

    const result = await checkKnowledgeFreshness({ rootDir });

    expect(
      result.issues
        .filter((issue) => issue.packageName === '@acme/ui-host')
        .map((issue) => issue.code),
    ).toEqual(['nested-agents-md']);
  });
});

let counter = 0;

async function writeWorkspaceYaml(
  rootDir: string,
  globs: string[],
): Promise<void> {
  await writeFile(
    join(rootDir, 'pnpm-workspace.yaml'),
    [
      'packages:',
      ...globs.map((glob) => `  - ${glob}`),
      '',
      'overrides:',
      "  '@types/node': 24.13.2",
      '',
    ].join('\n'),
  );
}

/** A package whose objects come from a package-local generated manifest. */
async function writeManifestPackage(
  rootDir: string,
  relativeDir: string,
  packageName: string,
  classNames: string[],
  dependencies: Record<string, string> = {},
  explicitObjects?: Record<string, unknown>,
): Promise<void> {
  const pkgDir = join(rootDir, relativeDir);
  await mkdir(join(pkgDir, '.smrt'), { recursive: true });
  await writeFile(
    join(pkgDir, 'package.json'),
    JSON.stringify(
      { name: packageName, version: '1.0.0', dependencies },
      null,
      2,
    ),
  );
  await writeFile(
    join(pkgDir, '.smrt', 'manifest.json'),
    JSON.stringify({
      version: '1',
      packageName,
      objects:
        explicitObjects ??
        Object.fromEntries(
          classNames.map((className) => [
            `${packageName}:${className}`,
            {
              className,
              qualifiedName: `${packageName}:${className}`,
              collection: `${className.toLowerCase()}s`,
              extends: 'SmrtObject',
              fields: { ownerId: { type: 'foreignKey', related: 'Owner' } },
              schema: { tableName: `${className.toLowerCase()}s` },
            },
          ]),
        ),
    }),
  );
}
