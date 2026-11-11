import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types.js';
import { generateSvelteKitRoutes } from '../vite-plugin/sveltekit-generator.js';
import { buildWebRelationships } from '../vite-plugin/web-collections.js';
import { separateHostedStiCollections } from './hosted-sti-collections.js';

it('hosts the effective app STI children when the exposure list names their providers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hosted-replacements-'));
  try {
    const objects: SmartObjectManifest['objects'] = {};
    for (const [packageName, className, parent] of [
      ['@fixture/provider', 'Contract', 'SmrtObject'],
      ['@fixture/provider', 'Agreement', '@fixture/provider:Contract'],
      ['@fixture/app', 'Contract', '@fixture/provider:Contract'],
      ['@fixture/app', 'Agreement', '@fixture/provider:Agreement'],
    ]) {
      const qualifiedName = `${packageName}:${className}`;
      objects[qualifiedName] = {
        name: className,
        className,
        qualifiedName,
        packageName,
        filePath: join(root, 'src', `${className}.ts`),
        extends: parent.includes(':') ? parent.split(':')[1] : parent,
        ...(parent.includes(':') ? { extendsQualified: parent } : {}),
        collection: 'contracts',
        fields: { title: { type: 'text' } },
        methods: {},
        decoratorConfig: {
          tableName: 'contracts',
          tableStrategy: 'sti',
          ...(packageName === '@fixture/provider'
            ? { api: { include: ['list', 'get', 'create'] } }
            : {}),
        },
      } as SmartObjectDefinition;
    }
    const manifest = {
      packageName: '@fixture/app',
      version: '1.0.0',
      timestamp: 0,
      objects,
    } as SmartObjectManifest;
    objects['@fixture/app:Agreement'].fields.contractId = {
      type: 'foreignKey',
      related: '@fixture/provider:Contract',
    };
    const hosted = separateHostedStiCollections(
      manifest,
      ['@fixture/provider:Contract', '@fixture/provider:Agreement'],
      (key, def) => def.qualifiedName ?? key,
    );
    expect(
      buildWebRelationships(hosted.objects['@fixture/app:Agreement'], hosted),
    ).toContainEqual({
      field: 'contractId',
      kind: 'foreignKey',
      relatedCollection: 'contracts',
    });
    expect(hosted.objects['@fixture/app:Agreement']).toMatchObject({
      collection: 'agreements',
      permissionCollection: 'contracts',
    });
    expect(hosted.objects['@fixture/app:Contract'].collection).toBe(
      'contracts',
    );
    expect(
      hosted.objects['@fixture/app:Agreement'].decoratorConfig?.api,
    ).toEqual({ include: ['list', 'get', 'create'] });
    expect(manifest.objects['@fixture/app:Agreement'].collection).toBe(
      'contracts',
    );
    await generateSvelteKitRoutes(root, hosted, {
      enabled: true,
      rejectRouteCollisions: true,
      routesDir: 'src/routes/api',
      objectsDir: 'src',
      configPath: 'src/lib/server',
    });
    expect(
      await readFile(
        join(root, 'src/routes/api/agreements/+server.ts'),
        'utf8',
      ),
    ).toContain('Agreement');
    expect(
      await readFile(join(root, 'src/routes/api/contracts/+server.ts'), 'utf8'),
    ).toContain('Contract');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('aliases colliding host routes while preserving storage, permissions and provider input', async () => {
  const { aliasHostedCollections } = await import(
    './hosted-sti-collections.js'
  );
  const object = (packageName: string) => ({
    className: 'Account',
    name: 'account',
    qualifiedName: `${packageName}:Account`,
    packageName,
    collection: 'accounts',
    filePath: 'account.ts',
    fields: {},
    methods: {},
    decoratorConfig: { tableName: `${packageName.split('/')[1]}_accounts` },
  });
  const manifest = {
    objects: {
      '@fixture/a:Account': object('@fixture/a'),
      '@fixture/b:Account': object('@fixture/b'),
    },
  };
  const aliased = aliasHostedCollections(manifest);
  expect(aliased.objects['@fixture/a:Account'].collection).toBe('accounts');
  expect(aliased.objects['@fixture/b:Account']).toMatchObject({
    collection: 'b-accounts',
    permissionCollection: 'accounts',
    decoratorConfig: { tableName: 'b_accounts', collection: 'b-accounts' },
  });
  expect(
    aliasHostedCollections(manifest, {}, ['@fixture/b:Account']).objects[
      '@fixture/b:Account'
    ].collection,
  ).toBe('accounts');
  const replaced = {
    objects: {
      ...manifest.objects,
      '@fixture/z:Account': {
        ...object('@fixture/z'),
        extends: 'Account',
        extendsQualified: '@fixture/a:Account',
        decoratorConfig: { tableName: 'a_accounts' },
      },
    },
  };
  const replacementAliases = aliasHostedCollections(replaced, {}, [
    '@fixture/a:Account',
    '@fixture/b:Account',
  ]);
  expect(replacementAliases.objects['@fixture/z:Account'].collection).toBe(
    'accounts',
  );
  expect(replacementAliases.objects['@fixture/b:Account'].collection).toBe(
    'b-accounts',
  );
  expect(manifest.objects['@fixture/b:Account'].collection).toBe('accounts');
  expect(
    aliasHostedCollections(manifest, { '@fixture/b:Account': 'messages' })
      .objects['@fixture/b:Account'].collection,
  ).toBe('messages');
  expect(() =>
    aliasHostedCollections(manifest, { '@fixture/b:Account': '../escape' }),
  ).toThrow('Invalid hosted collection alias');
});
