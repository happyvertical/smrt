import { describe, expect, it } from 'vitest';
import { dropUnrenderableRecipes } from '../src/lib/catalog/generate/build.ts';
import {
  extractPackage,
  packageId,
  type RawPackage,
  resolveDependencies,
} from '../src/lib/catalog/generate/extract.ts';

const raw: RawPackage = {
  packageName: '@happyvertical/smrt-shop',
  version: '1.0.0',
  description: 'A shop',
  knowledge: null,
  manifest: {
    packageName: '@happyvertical/smrt-shop',
    smrtDependencies: ['@happyvertical/smrt-core', '@happyvertical/smrt-tags'],
    objects: {
      '@happyvertical/smrt-shop:Item': {
        className: 'Item',
        qualifiedName: '@happyvertical/smrt-shop:Item',
        collection: 'items',
        fields: {
          tenantId: { type: 'text' },
          name: { type: 'text', required: true },
          price: { type: 'integer', default: 0 },
          label: {
            type: 'crossPackageRef',
            related: '@happyvertical/smrt-tags:Tag',
          },
          lines: { type: 'oneToMany' },
        },
        methods: {
          restock: {
            name: 'restock',
            async: true,
            parameters: [{ name: 'n', type: 'number', optional: true }],
            returnType: 'Promise<void>',
          },
        },
        decoratorConfig: { api: { include: ['list', 'get'] }, mcp: false },
      },
      '@happyvertical/smrt-shop:ItemCollection': {
        className: 'ItemCollection',
        qualifiedName: '@happyvertical/smrt-shop:ItemCollection',
        collection: 'items',
        extendsTypeArg: 'Item',
        fields: {},
        methods: {},
        decoratorConfig: {},
      },
    },
  },
};

describe('extractPackage', () => {
  const pkg = extractPackage(raw);
  const item = pkg.models[0];

  it('keeps models, drops collections and relation-only fields', () => {
    expect(pkg.id).toBe('shop');
    expect(pkg.models).toHaveLength(1);
    expect(item.fields.map((f) => f.name)).toEqual([
      'tenantId',
      'name',
      'price',
      'label',
    ]);
    expect(item.fields[0].system).toBe(true);
    expect(item.fields[1].required).toBe(true);
  });

  it('keeps fieldless task models and their recipes without promoting collections', () => {
    const task = '@happyvertical/smrt-webhooks:WebhookDeliveryTask';
    const retryTask = '@happyvertical/smrt-webhooks:WebhookRetryTask';
    const collection = '@happyvertical/smrt-webhooks:WebhookDeliveryCollection';
    const fixture: RawPackage = {
      packageName: '@happyvertical/smrt-webhooks',
      version: '0.55.11',
      description: 'Outbound webhooks',
      knowledge: null,
      manifest: {
        packageName: '@happyvertical/smrt-webhooks',
        objects: {
          [task]: {
            className: 'WebhookDeliveryTask',
            qualifiedName: task,
            collection: 'webhookdeliverytasks',
            extends: 'SmrtObject',
            schema: { tableName: '_smrt_webhook_delivery_tasks' },
            fields: {},
            methods: {},
            decoratorConfig: { api: false, mcp: false, cli: false },
          },
          [collection]: {
            className: 'WebhookDeliveryCollection',
            qualifiedName: collection,
            collection: 'webhookdeliveries',
            extends: 'SmrtCollection',
            extendsTypeArg: 'WebhookDelivery',
            schema: { tableName: '_smrt_webhook_deliveries' },
            fields: {},
            methods: {},
            decoratorConfig: {},
          },
          [retryTask]: {
            className: 'WebhookRetryTask',
            qualifiedName: retryTask,
            collection: 'webhookretrytasks',
            extends: 'ApplicationTask',
            schema: { tableName: '_smrt_webhook_retry_tasks' },
            fields: {},
            methods: {},
            decoratorConfig: { api: false, mcp: false, cli: false },
          },
        },
        recipes: [
          {
            id: 'integrations.webhooks',
            label: 'Outbound webhooks',
            summary: 'Deliver signed events.',
            synonyms: [],
            models: [task],
            nav: [],
            requires: [],
            runtime: 'server',
          },
        ],
      },
    };
    const extracted = extractPackage(fixture);
    expect(extracted.models.map((model) => model.id)).toEqual([
      task,
      retryTask,
    ]);
    expect(extracted.models[0].exposed).toBe(false);
    const log: string[] = [];
    const catalog = dropUnrenderableRecipes([extracted], (message) =>
      log.push(message),
    );
    expect(catalog[0]?.recipes?.map((recipe) => recipe.id)).toEqual([
      'integrations.webhooks',
    ]);
    expect(log).toEqual([]);
  });

  it('excludes derived collections by manifest ancestry, including qualified bases', () => {
    const packageName = '@happyvertical/smrt-messages';
    const account = `${packageName}:EmailAccount`;
    const base = `${packageName}:AccountCollection`;
    const derived = `${packageName}:EmailAccountCollection`;
    const indirect = `${packageName}:MailAccounts`;
    const common = {
      collection: 'accounts',
      fields: {},
      methods: {},
      decoratorConfig: {},
      schema: { tableName: 'accounts' },
    };
    const fixture: RawPackage = {
      packageName,
      version: '0.55.11',
      description: 'Messages',
      knowledge: null,
      manifest: {
        packageName,
        objects: {
          [account]: {
            ...common,
            className: 'EmailAccount',
            qualifiedName: account,
            extends: 'Account',
            fields: { name: { type: 'text' } },
          },
          [base]: {
            ...common,
            className: 'AccountCollection',
            qualifiedName: base,
            extends: 'SmrtCollection',
            extendsTypeArg: 'Account',
          },
          [derived]: {
            ...common,
            className: 'EmailAccountCollection',
            qualifiedName: derived,
            extends: 'AccountCollection',
          },
          [indirect]: {
            ...common,
            className: 'MailAccounts',
            qualifiedName: indirect,
            extends: derived,
          },
        },
      },
    };
    expect(extractPackage(fixture).models.map((model) => model.id)).toEqual([
      account,
    ]);
  });

  it('terminates malformed cyclic ancestry without dropping legacy value models', () => {
    const fixture = structuredClone(raw);
    const item = fixture.manifest.objects['@happyvertical/smrt-shop:Item'];
    item.extends = item.qualifiedName;
    expect(extractPackage(fixture).models.map((model) => model.id)).toEqual([
      item.qualifiedName,
    ]);
  });

  it('derives surfaces from decoratorConfig when there is no knowledge', () => {
    expect(pkg.surfaceSource).toBe('manifest');
    expect(item.rest).toEqual([
      { method: 'GET', path: '/items' },
      { method: 'GET', path: '/items/[id]' },
    ]);
    expect(item.mcp).toEqual([]);
    expect(item.cli.map((c) => c.name)).toContain('item_create');
    expect(item.exposed).toBe(true);
  });

  it('records references and resolves catalog-only dependencies', () => {
    expect(item.references).toEqual(['@happyvertical/smrt-tags:Tag']);
    const tags = { ...pkg, id: 'tags', dependencies: [] };
    const resolved = resolveDependencies([pkg, tags]);
    expect(resolved[0].dependencies).toEqual(['tags']);
  });

  it('prefers knowledge surfaces when present', () => {
    const withKnowledge = extractPackage({
      ...raw,
      knowledge: {
        surfaces: [
          {
            kind: 'mcp',
            name: 'item_restock',
            operation: 'restock',
            objectName: '@happyvertical/smrt-shop:Item',
          },
        ],
      },
    });
    expect(withKnowledge.models[0].rest).toEqual([]);
    expect(withKnowledge.models[0].mcp[0].name).toBe('item_restock');
    expect(withKnowledge.models[0].methods[0].aiCallable).toBe(true);
  });

  it('strips the scope and prefix from package names', () => {
    expect(packageId('@happyvertical/smrt-products')).toBe('products');
  });
});

describe('extractPackage field hints', () => {
  it('carries ui hints and enum values through, dropping junk', () => {
    const pkg = extractPackage({
      ...raw,
      manifest: {
        ...raw.manifest,
        objects: {
          '@happyvertical/smrt-shop:Item': {
            ...raw.manifest.objects['@happyvertical/smrt-shop:Item'],
            fields: {
              name: {
                type: 'text',
                required: true,
                _meta: {
                  ui: { basic: true, group: 'Main', order: 2, junk: 1 },
                },
              },
              kind: { type: 'text', enum: ['a', 'b'] },
              bad: { type: 'text', enum: [1, 2], _meta: { ui: 'x' } },
            },
          },
        },
      },
    });
    const fields = Object.fromEntries(
      pkg.models[0].fields.map((f) => [f.name, f]),
    );
    expect(fields.name.ui).toEqual({ basic: true, group: 'Main', order: 2 });
    expect(fields.kind.enum).toEqual(['a', 'b']);
    expect(fields.bad.enum).toBeUndefined();
    expect(fields.bad.ui).toBeUndefined();
  });

  it('reads widget hints and the display label field, ignoring unknown ones', () => {
    const item = raw.manifest.objects['@happyvertical/smrt-shop:Item'];
    const pkg = extractPackage({
      ...raw,
      manifest: {
        ...raw.manifest,
        objects: {
          '@happyvertical/smrt-shop:Item': {
            ...item,
            displayLabelField: 'name',
            fields: {
              name: { type: 'text', _meta: { ui: { widget: 'textarea' } } },
              other: { type: 'text', _meta: { ui: { widget: 'sparkles' } } },
            },
          },
        },
      },
    });
    const fields = Object.fromEntries(
      pkg.models[0].fields.map((f) => [f.name, f]),
    );
    expect(fields.name.ui).toEqual({ widget: 'textarea' });
    expect(fields.other.ui).toBeUndefined();
    expect(pkg.models[0].display).toEqual({ label: 'name' });
  });

  it('reads field descriptions from the field or its _meta, trimmed', () => {
    const item = raw.manifest.objects['@happyvertical/smrt-shop:Item'];
    const pkg = extractPackage({
      ...raw,
      manifest: {
        ...raw.manifest,
        objects: {
          '@happyvertical/smrt-shop:Item': {
            ...item,
            fields: {
              a: { type: 'text', description: ' The name. ' },
              b: { type: 'text', _meta: { description: 'The price.' } },
              c: { type: 'text', description: '   ' },
            },
          },
        },
      },
    });
    const fields = Object.fromEntries(
      pkg.models[0].fields.map((f) => [f.name, f]),
    );
    expect(fields.a.description).toBe('The name.');
    expect(fields.b.description).toBe('The price.');
    expect('description' in fields.c).toBe(false);
  });

  it('drops a display label field the model does not have', () => {
    const item = raw.manifest.objects['@happyvertical/smrt-shop:Item'];
    const pkg = extractPackage({
      ...raw,
      manifest: {
        ...raw.manifest,
        objects: {
          '@happyvertical/smrt-shop:Item': {
            ...item,
            displayLabelField: 'zzz',
          },
        },
      },
    });
    expect(pkg.models[0].display).toBeUndefined();
  });
});
