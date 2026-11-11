import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types.js';
import { generateSvelteKitRoutes } from '../vite-plugin/sveltekit-generator.js';
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
    const hosted = separateHostedStiCollections(
      manifest,
      ['@fixture/provider:Contract', '@fixture/provider:Agreement'],
      (key, def) => def.qualifiedName ?? key,
    );
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
