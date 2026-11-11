import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { smrtConsumer } from '../consumer-plugin/index.js';
import {
  createConsumerWorkspace,
  manifestEntry,
} from '../registry/__tests__/helpers/consumer-workspace.js';
import type { SmartObjectManifest } from '../scanner/types.js';
import { generateSvelteKitRoutes } from '../vite-plugin/sveltekit-generator.js';
import { smrt } from '../vite-preset/index.js';
import {
  buildActivationManifest,
  generateActivationRegistration,
} from './generate.js';
import { activationClosure } from './manifest.js';

const core = fileURLToPath(new URL('../..', import.meta.url));
const workspaces: ReturnType<typeof createConsumerWorkspace>[] = [];
afterEach(() => {
  for (const workspace of workspaces.splice(0)) workspace.dispose();
});

function workspace() {
  const files = createConsumerWorkspace('activation-generation');
  workspaces.push(files);
  files.write(
    'package.json',
    JSON.stringify({ name: '@activation/app', type: 'module' }),
  );
  const coreLink = files.path('node_modules/@happyvertical/smrt-core');
  mkdirSync(dirname(coreLink), { recursive: true });
  symlinkSync(core, coreLink, 'dir');
  const objects: SmartObjectManifest['objects'] = {};
  for (const name of ['Customer', 'Invoice', 'Unused']) {
    const pkg = `@activation/${name.toLowerCase()}`;
    const root = `node_modules/${pkg}`;
    files.write(
      `${root}/package.json`,
      JSON.stringify({ name: pkg, type: 'module', exports: './index.js' }),
    );
    files.write(
      `${root}/index.js`,
      `import { SmrtObject } from '@happyvertical/smrt-core';
      ${name === 'Invoice' ? "import '@activation/customer';" : ''}
      globalThis.activationImports ??= [];
      globalThis.activationImports.push(${JSON.stringify(name)});
      export class ${name} extends SmrtObject {}
    `,
    );
    const id = `${pkg}:${name}`;
    objects[id] = manifestEntry({
      className: name,
      packageName: pkg,
      filePath: files.path(`${root}/index.js`),
      tableName: `fixture_${name.toLowerCase()}`,
      fields: { title: { type: 'text' } },
    });
    objects[id].schema!.columns = {
      id: { type: 'TEXT', primaryKey: true },
      title: { type: 'TEXT' },
    };
    objects[id].importPath = pkg;
    files.write(
      `${root}/manifest.json`,
      JSON.stringify({
        version: '1',
        timestamp: 0,
        packageName: pkg,
        objects: { [id]: objects[id] },
      }),
    );
  }
  const appId = '@activation/app:Customer';
  files.write(
    'src/lib/objects/customer.js',
    `import { Customer as Base } from '@activation/customer';
    globalThis.activationImports ??= [];
    globalThis.activationImports.push('AppCustomer');
    export class Customer extends Base {}
  `,
  );
  objects[appId] = {
    ...objects['@activation/customer:Customer'],
    packageName: '@activation/app',
    qualifiedName: appId,
    importPath: undefined,
    filePath: files.path('src/lib/objects/customer.js'),
    extends: 'Customer',
    extendsQualified: '@activation/customer:Customer',
    schema: {
      ...objects['@activation/customer:Customer'].schema!,
      columns: {
        ...objects['@activation/customer:Customer'].schema!.columns,
        preferred_pose: { type: 'TEXT' },
      },
    },
  };
  const manifest: SmartObjectManifest = {
    version: '1',
    timestamp: 0,
    packageName: '@activation/app',
    objects,
  };
  files.write('.smrt/manifest.json', JSON.stringify(manifest));
  return { files, manifest };
}

describe('AOT activation generation', () => {
  it('resolves legacy unqualified report ancestry to its framework owner without inventing a table/model', () => {
    const { files, manifest } = workspace();
    manifest.objects['@activation/unused:Unused'].extends = 'SmrtReport';
    manifest.objects['@happyvertical/smrt-reports:SmrtReport'] = manifestEntry({
      className: 'SmrtReport',
      packageName: '@happyvertical/smrt-reports',
      filePath: '/framework/report.ts',
      tableName: 'not_a_resource',
      fields: {},
    });
    const generated = generateActivationRegistration(manifest, {
      projectRoot: files.root,
      outputDir: files.path('.smrt'),
    });
    expect(
      activationClosure(generated.manifest, ['@activation/unused:Unused'])
        .models,
    ).toEqual(['@activation/unused:Unused']);
    expect(generated.manifest.tables).not.toHaveProperty('not_a_resource');
  });
  it('refuses a different nested provider context instead of importing the host copy', () => {
    const { files, manifest } = workspace();
    const entry = manifest.objects['@activation/customer:Customer'];
    Object.assign(entry, { providerPackageName: '@activation/invoice' });
    files.write(
      'node_modules/@activation/invoice/node_modules/@activation/customer/package.json',
      JSON.stringify({
        name: '@activation/customer',
        type: 'module',
        exports: './index.js',
      }),
    );
    files.write(
      'node_modules/@activation/invoice/node_modules/@activation/customer/index.js',
      'export class Customer {}',
    );
    expect(() =>
      generateActivationRegistration(manifest, {
        projectRoot: files.root,
        outputDir: files.path('.smrt'),
      }),
    ).toThrow(/same host\/provider package context/);
  });
  it('does not evaluate constructors, and includes static module imports and same-name table owners', () => {
    const { files, manifest } = workspace();
    const generated = generateActivationRegistration(manifest, {
      projectRoot: files.root,
      outputDir: files.path('.smrt'),
    });
    expect(generated.source).not.toMatch(/import .* from ['"]@activation/);
    expect(generated.source).toContain('await import("@activation/unused")');
    expect(generated.source).not.toContain(files.root);
    expect(
      activationClosure(generated.manifest, ['@activation/invoice:Invoice'])
        .models,
    ).toEqual([
      '@activation/app:Customer',
      '@activation/customer:Customer',
      '@activation/invoice:Invoice',
    ]);
    const broken = structuredClone(generated.manifest.modules);
    broken['@activation/invoice'].dependencies.push('missing');
    expect(() => buildActivationManifest(manifest, broken)).toThrow(
      /Unknown activation module/,
    );
    manifest.objects['@activation/invoice:Invoice'].fields.ownerId = {
      type: 'crossPackageRef',
      related: 'UNRESOLVED_CONSTANT',
    };
    expect(() =>
      generateActivationRegistration(manifest, {
        projectRoot: files.root,
        outputDir: files.path('.smrt'),
      }),
    ).toThrow(/Unresolved activation reference.*UNRESOLVED_CONSTANT/);
  });

  it('generated registration boots, enables and recovers in independent plain Node processes', () => {
    const { files, manifest } = workspace();
    const collectionId = '@activation/app:Customers';
    files.write(
      'src/lib/objects/customers.js',
      "import { SmrtCollection } from '@happyvertical/smrt-core';\nimport { Customer } from './customer.js';\nexport class Customers extends SmrtCollection { static _itemClass = Customer; marker() { return 42; } }\n",
    );
    const collection = manifestEntry({
      className: 'Customers',
      packageName: '@activation/app',
      filePath: files.path('src/lib/objects/customers.js'),
      tableName: 'fixture_customer',
      fields: {},
    });
    collection.extends = 'SmrtCollection';
    collection.extendsTypeArg = '@activation/app:Customer';
    collection.collectionOf = '@activation/app:Customer';
    delete collection.schema;
    manifest.objects[collectionId] = collection;
    const generated = generateActivationRegistration(manifest, {
      projectRoot: files.root,
      outputDir: files.path('.smrt'),
    });
    files.write('.smrt/register.js', generated.source);
    files.write(
      'recover.mjs',
      `import assert from 'node:assert/strict';
      import { readFileSync, writeFileSync, existsSync } from 'node:fs';
      import { ObjectRegistry } from '@happyvertical/smrt-core';
      import { createActivationCoordinator } from '@happyvertical/smrt-core/activation';
      import { getDatabase } from ${JSON.stringify(new URL('../../node_modules/@happyvertical/sql/dist/index.js', import.meta.url).href)};
      import { activationManifest, activationLoaders } from './.smrt/register.js';
      assert.equal(globalThis.activationImports, undefined);
      const enabled = existsSync('enabled.json') ? JSON.parse(readFileSync('enabled.json', 'utf8')) : ['@activation/customer:Customer'];
      const db = await getDatabase({ type: 'sqlite', url: 'application.sqlite' });
      const coordinator = createActivationCoordinator({ scope: 'app', db, packageName: '@activation/app', manifest: activationManifest, loaders: activationLoaders, readEnabled: async () => enabled });
      await coordinator.boot();
      assert.equal(ObjectRegistry.getClass('@activation/unused:Unused'), undefined);
      assert.equal(ObjectRegistry.getClass('@activation/app:Customer').constructor.name, 'Customer');
      assert.equal((await ObjectRegistry.getCollection('@activation/app:Customer', { db })).marker(), 42);
      const boot = (await db.query("SELECT name FROM sqlite_master WHERE name LIKE 'fixture_%' AND type = 'table'")).rows;
      assert.equal(boot.length, process.argv.includes('--restart') ? 2 : 1);
      await coordinator.activate(['@activation/invoice:Invoice']);
      assert.equal(coordinator.isReady('@activation/invoice:Invoice'), true);
      if (process.argv.includes('--restart')) assert.equal((await db.query("SELECT title FROM fixture_invoice WHERE id = 'saved'")).rows[0].title, 'retained');
      else await db.query("INSERT INTO fixture_invoice (id, slug, context, title) VALUES ('saved', 'saved', '', 'retained')");
      writeFileSync('enabled.json', JSON.stringify(['@activation/invoice:Invoice']));
      assert.deepEqual([...new Set(globalThis.activationImports)].sort(), ['AppCustomer', 'Customer', 'Invoice']);
      await db.close();
    `,
    );
    for (const args of [[], ['--restart']]) {
      const child = spawnSync(process.execPath, ['recover.mjs', ...args], {
        cwd: files.root,
        encoding: 'utf8',
      });
      expect(child.status, child.stderr || child.stdout).toBe(0);
    }
  });

  it('consumer opt-in and SvelteKit registration both emit deferred loaders for the superset', async () => {
    const { files, manifest } = workspace();
    // Consumer buildStart uses the merged app/provider manifest, even when the
    // route allowlist selects fewer models. No runtime provider is evaluated.
    const plugin = smrtConsumer({
      projectRoot: files.root,
      packages: [
        '@activation/customer',
        '@activation/invoice',
        '@activation/unused',
      ],
      generateTypes: false,
      lazyActivation: true,
    });
    const hook = plugin.buildStart!;
    const handler = typeof hook === 'function' ? hook : hook.handler;
    await handler.call(
      {} as ThisParameterType<typeof handler>,
      {} as Parameters<typeof handler>[0],
    );
    expect(readFileSync(files.path('.smrt/register.js'), 'utf8')).toContain(
      'export const activationLoaders',
    );
    files.write('src/lib/server/smrt.ts', 'export const options = {};');
    await generateSvelteKitRoutes(files.root, manifest, {
      enabled: true,
      lazyActivation: true,
      routesDir: 'src/routes/api',
      objectsDir: 'src/lib/objects',
      changesRoute: { enabled: false },
      eventsRoute: { enabled: false },
      resourcesRoute: { enabled: false },
    });
    const source = readFileSync(
      files.path('src/lib/server/smrt-register.ts'),
      'utf8',
    );
    expect(source).toContain('await import("../objects/customer.js")');
    expect(source).not.toMatch(/import .* from ['"]@activation/);
    expect(
      JSON.parse(
        readFileSync(files.path('.smrt/activation-manifest.json'), 'utf8'),
      ).models,
    ).toHaveProperty('@activation/unused:Unused');
  });

  it('defers route serializers and includes their static model dependencies in the graph', async () => {
    const { files, manifest } = workspace();
    files.write(
      'src/lib/server/serialize.js',
      "import '@activation/unused';\nexport const item = (value) => value;",
    );
    manifest.objects['@activation/customer:Customer'].decoratorConfig.api = {
      serializers: {
        item: { importPath: '$lib/server/serialize.js', exportName: 'item' },
      },
    };
    const generated = generateActivationRegistration(manifest, {
      projectRoot: files.root,
      outputDir: files.path('.smrt'),
    });
    expect(
      activationClosure(generated.manifest, ['@activation/customer:Customer'])
        .models,
    ).toContain('@activation/unused:Unused');
    files.write('src/lib/server/smrt.ts', 'export const options = {};');
    await generateSvelteKitRoutes(files.root, manifest, {
      enabled: true,
      lazyActivation: true,
      routesDir: 'src/routes/api',
      objectsDir: 'src/lib/objects',
      changesRoute: { enabled: false },
      eventsRoute: { enabled: false },
      resourcesRoute: { enabled: false },
    });
    const route = readFileSync(
      files.path('src/routes/api/fixture_customer/[id]/+server.ts'),
      'utf8',
    );
    expect(route).toContain("await import('$lib/server/serialize.js')");
    expect(route).not.toContain("from '$lib/server/serialize.js'");
  });

  it('the public preset coordinates producer and consumer lazy registration on a clean host', async () => {
    const { files } = workspace();
    files.write(
      'src/lib/objects/customer.ts',
      "import { smrt } from '@happyvertical/smrt-core';\nimport { Customer as Base } from '@activation/customer';\n@smrt()\nexport class Customer extends Base {}\n",
    );
    const plugins = await smrt({
      projectRoot: files.root,
      lazyActivation: true,
      packages: [
        '@activation/customer',
        '@activation/invoice',
        '@activation/unused',
      ],
      expose: [
        '@activation/customer:Customer',
        '@activation/invoice:Invoice',
        '@activation/unused:Unused',
      ],
      include: ['src/lib/objects/**/*.ts'],
    });
    const config = { root: files.root, plugins };
    const env = { command: 'build' as const, mode: 'production' };
    for (const plugin of plugins) {
      const hook = plugin.config;
      if (!hook) continue;
      const handler = typeof hook === 'function' ? hook : hook.handler;
      await handler.call({} as ThisParameterType<typeof handler>, config, env);
    }
    const source = readFileSync(
      files.path('src/lib/server/smrt-register.ts'),
      'utf8',
    );
    expect(source).toContain('export const activationLoaders');
    expect(source).not.toMatch(/import .* from ['"]@activation/);
    const graph = JSON.parse(
      readFileSync(files.path('.smrt/activation-manifest.json'), 'utf8'),
    );
    expect(graph.models).toHaveProperty('@activation/app:Customer');
    expect(graph.models).toHaveProperty('@activation/unused:Unused');
  });
});
