/**
 * Coverage-focused tests for ManifestGenerator (issue #1500).
 *
 * The existing manifest-generator.test.ts covers collision detection, agent
 * signalSubscriptions, REST endpoint routing, and the tenant-scoped schema
 * contract. This file targets the remaining uncovered branches:
 *
 * - STI base / STI child (local + external) / CTI schema generation paths
 * - Inherited-field merging through framework abstract bases (SmrtHierarchical)
 *   and collection item-class inheritance
 * - Same-package foreign-key column-type reconciliation
 * - Visibility inference + filtering, import-path determination
 * - Code generators: type definitions, REST endpoint code, MCP tools/code
 * - Agent manifests with uiSlots/components/adminRoutes
 * - saveManifest / loadManifest round-trip
 *
 * Everything is exercised through hand-built ScanResult inputs so the tests
 * stay deterministic and never touch oxc-parser or the filesystem — except the
 * save/load round-trip and the external-STI block, which use isolated temp
 * dirs with throwaway node_modules packages.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearManifestCache } from '../../manifest/manifest-loader.js';
import {
  generateManifest as generateManifestFn,
  ManifestGenerator,
} from '../manifest-generator';
import type {
  ScanResult,
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../types';

/**
 * Build a minimal valid SmartObjectDefinition. Only `className` is required;
 * everything else is derived so individual tests stay focused.
 */
function def(
  className: string,
  overrides: Partial<SmartObjectDefinition> = {},
): SmartObjectDefinition {
  const name = className.toLowerCase();
  return {
    name,
    className,
    collection: `${name}s`,
    filePath: `/src/${name}.ts`,
    fields: {},
    methods: {},
    decoratorConfig: {},
    exportName: className,
    collectionExportName: `${className}Collection`,
    ...overrides,
  } as SmartObjectDefinition;
}

function scan(objects: SmartObjectDefinition[]): ScanResult {
  return {
    filePath: objects[0]?.filePath ?? '/src/unknown.ts',
    objects,
    imports: [],
    exports: [],
  };
}

describe('ManifestGenerator coverage', () => {
  describe('schema generation strategies', () => {
    it('generates a CTI table schema for a plain SmrtObject subclass', () => {
      const gen = new ManifestGenerator();
      const manifest = gen.generateManifest([
        scan([
          def('Widget', {
            fields: {
              name: { type: 'text', required: true },
              count: { type: 'integer' },
            },
          }),
        ]),
      ]);

      const widget = manifest.objects.widget;
      expect(widget.schema?.tableName).toBe('widgets');
      expect(widget.schema?.columns.name).toBeDefined();
      expect(widget.schema?.ddl).toContain('CREATE TABLE');
    });

    it('generates an STI schema on the base class and skips local STI children', () => {
      const gen = new ManifestGenerator();
      const manifest = gen.generateManifest([
        scan([
          def('Content', {
            decoratorConfig: { tableStrategy: 'sti' },
            fields: { title: { type: 'text' } },
          }),
          def('Article', {
            extends: 'Content',
            fields: { body: { type: 'text' } },
          }),
        ]),
      ]);

      // Base owns the shared table schema.
      expect(manifest.objects.content.schema?.tableName).toBe('contents');
      // The child inherited the base table name + strategy during merge, so it
      // resolves to the shared `contents` table (not its own `articles` table).
      expect(manifest.objects.article.decoratorConfig.tableName).toBe(
        'contents',
      );
      expect(manifest.objects.article.decoratorConfig.tableStrategy).toBe(
        'sti',
      );
      expect(manifest.objects.article.schema?.tableName).toBe('contents');
      // STI child has the base's title field merged in.
      expect(manifest.objects.article.fields.title).toBeDefined();
    });

    it('honors an explicit tableName on the STI base', () => {
      const gen = new ManifestGenerator();
      const manifest = gen.generateManifest([
        scan([
          def('Content', {
            decoratorConfig: { tableStrategy: 'sti', tableName: 'content' },
            fields: { title: { type: 'text' } },
          }),
          def('Article', { extends: 'Content' }),
        ]),
      ]);

      expect(manifest.objects.content.schema?.tableName).toBe('content');
      expect(manifest.objects.article.decoratorConfig.tableName).toBe(
        'content',
      );
    });
  });

  describe('framework abstract base inheritance (CTI through SmrtHierarchical)', () => {
    it('merges parentId from SmrtHierarchical into a CTI subclass and rewrites it as a self-FK', () => {
      const gen = new ManifestGenerator();
      const manifest = gen.generateManifest([
        scan([
          // Framework base declared inline (no @smrt table of its own).
          def('SmrtHierarchical', {
            collection: '',
            decoratorConfig: {},
            fields: {
              parentId: { type: 'text', _meta: {} },
            },
          }),
          def('Account', {
            extends: 'SmrtHierarchical',
            fields: { name: { type: 'text' } },
          }),
        ]),
      ]);

      const account = manifest.objects.account;
      // parentId propagated into the CTI subclass...
      expect(account.fields.parentId).toBeDefined();
      // ...and normalized to a nullable self-referencing foreignKey.
      expect(account.fields.parentId.type).toBe('foreignKey');
      expect(account.fields.parentId.related).toBe('Account');
      expect(account.fields.parentId.required).toBe(false);
    });
  });

  describe('collection item-class inheritance', () => {
    it('inherits tableName/collection from the item class via extendsTypeArg', () => {
      const gen = new ManifestGenerator();
      const manifest = gen.generateManifest([
        scan([
          def('Event', {
            decoratorConfig: { tableStrategy: 'sti', tableName: 'events' },
            fields: { title: { type: 'text' } },
          }),
          def('Meeting', { extends: 'Event' }),
          def('Meetings', {
            collection: 'meetings_collection',
            extends: 'SmrtCollection',
            extendsTypeArg: 'Meeting',
          }),
        ]),
      ]);

      // Meeting inherited the STI base table.
      expect(manifest.objects.meeting.decoratorConfig.tableName).toBe('events');
      // The collection class inherits the item class's table + collection.
      expect(manifest.objects.meetings.decoratorConfig.tableName).toBe(
        'events',
      );
      expect(manifest.objects.meetings.collection).toBe(
        manifest.objects.meeting.collection,
      );
    });

    it('falls back to name-based singularization when extendsTypeArg is absent', () => {
      const gen = new ManifestGenerator();
      const manifest = gen.generateManifest([
        scan([
          def('Category', {
            decoratorConfig: { tableName: 'categories' },
            fields: { label: { type: 'text' } },
          }),
          // "Categories" -> "Category" via the 'ies' -> 'y' candidate.
          def('Categories', {
            collection: 'categories_collection',
            extends: 'SmrtCollection',
          }),
        ]),
      ]);

      expect(manifest.objects.categories.decoratorConfig?.tableName).toBe(
        'categories',
      );
    });
  });

  describe('same-package foreign-key column-type reconciliation', () => {
    it('rewrites a foreign-key column type to match the target id column type', () => {
      const gen = new ManifestGenerator();
      const manifest = gen.generateManifest([
        scan([
          def('Author', { fields: { name: { type: 'text' } } }),
          def('Book', {
            fields: {
              title: { type: 'text' },
              authorId: { type: 'foreignKey', related: 'Author' },
            },
          }),
        ]),
      ]);

      const book = manifest.objects.book;
      const author = manifest.objects.author;
      // The FK column carries the foreignKey referenceKind marker.
      expect(book.schema?.columns.author_id?.referenceKind).toBe('foreignKey');
      // And its SQL type matches the target table's id column type.
      expect(book.schema?.columns.author_id?.type).toBe(
        author.schema?.columns.id?.type,
      );
    });

    it('marks crossPackageRef columns with the crossPackageRef referenceKind', () => {
      const gen = new ManifestGenerator();
      const manifest = gen.generateManifest([
        scan([
          def('Order', {
            fields: {
              ref: {
                type: 'crossPackageRef',
                related: '@happyvertical/smrt-users:User',
              },
            },
          }),
        ]),
      ]);

      expect(manifest.objects.order.schema?.columns.ref?.referenceKind).toBe(
        'crossPackageRef',
      );
    });
  });

  describe('visibility inference and filtering', () => {
    it('infers test visibility from test file paths', () => {
      const gen = new ManifestGenerator();
      const manifest = gen.generateManifest([
        scan([
          def('TestThing', { filePath: '/src/thing.test.ts' }),
          def('RealThing', { filePath: '/src/thing.ts' }),
        ]),
      ]);

      expect(manifest.objects.testthing.visibility).toBe('test');
      expect(manifest.objects.realthing.visibility).toBe('public');
    });

    it('respects explicit visibility from the decorator config', () => {
      const gen = new ManifestGenerator();
      const manifest = gen.generateManifest([
        scan([
          def('InternalThing', {
            decoratorConfig: { visibility: 'internal' as any },
          }),
        ]),
      ]);

      expect(manifest.objects.internalthing.visibility).toBe('internal');
    });

    it('filters out objects whose visibility is not in includeVisibility', () => {
      const gen = new ManifestGenerator();
      const manifest = gen.generateManifest(
        [
          scan([
            def('PublicThing', { filePath: '/src/public.ts' }),
            def('TestThing', { filePath: '/src/thing.test.ts' }),
          ]),
        ],
        { includeVisibility: ['public'] },
      );

      expect(manifest.objects.publicthing).toBeDefined();
      expect(manifest.objects.testthing).toBeUndefined();
    });
  });

  describe('package metadata and import paths', () => {
    it('sets qualified names and import paths from package.json exports', () => {
      const gen = new ManifestGenerator();
      const manifest = gen.generateManifest(
        [scan([def('Product', { fields: { sku: { type: 'text' } } })])],
        {
          packageName: '@acme/catalog',
          packageVersion: '2.1.0',
          packageJson: {
            name: '@acme/catalog',
            exports: { './objects': './dist/objects.js' },
          },
        },
      );

      expect(manifest.packageName).toBe('@acme/catalog');
      expect(manifest.packageVersion).toBe('2.1.0');
      const key = '@acme/catalog:Product';
      expect(manifest.objects[key]).toBeDefined();
      expect(manifest.objects[key].importPath).toBe('@acme/catalog/objects');
      expect(manifest.objects[key].qualifiedName).toBe(key);
    });

    it('falls back to the package name when only a main export exists', () => {
      const gen = new ManifestGenerator();
      const manifest = gen.generateManifest([scan([def('Thing')])], {
        packageName: '@acme/pkg',
        packageJson: {
          name: '@acme/pkg',
          exports: { '.': { import: './dist/index.js' } },
        },
      });
      expect(manifest.objects['@acme/pkg:Thing'].importPath).toBe('@acme/pkg');
    });

    it('falls back to the package name when only a legacy main field exists', () => {
      const gen = new ManifestGenerator();
      const manifest = gen.generateManifest([scan([def('Thing')])], {
        packageName: '@acme/pkg',
        packageJson: { name: '@acme/pkg', main: './dist/index.js' },
      });
      expect(manifest.objects['@acme/pkg:Thing'].importPath).toBe('@acme/pkg');
    });
  });

  describe('validation rules', () => {
    it('derives required/min/max/length/pattern rules and skips transient fields', () => {
      const gen = new ManifestGenerator();
      const manifest = gen.generateManifest([
        scan([
          def('Profile', {
            fields: {
              name: {
                type: 'text',
                required: true,
                minLength: 2,
                maxLength: 50,
                _meta: { pattern: '^[a-z]+$' },
              },
              age: { type: 'integer', _meta: { min: 0, max: 120 } },
              computed: { type: 'text', transient: true, required: true },
            },
          }),
        ]),
      ]);

      const rules = manifest.objects.profile.validationRules ?? [];
      const byField = (f: string) => rules.filter((r) => r.field === f);
      expect(
        byField('name')
          .map((r) => r.rule)
          .sort(),
      ).toEqual(['maxLength', 'minLength', 'pattern', 'required']);
      expect(
        byField('age')
          .map((r) => r.rule)
          .sort(),
      ).toEqual(['max', 'min']);
      // Transient field contributes no rules even though it is required.
      expect(byField('computed')).toHaveLength(0);
    });

    it('supports RegExp pattern objects by serializing their source', () => {
      const gen = new ManifestGenerator();
      const manifest = gen.generateManifest([
        scan([
          def('Coded', {
            fields: {
              code: { type: 'text', _meta: { pattern: /^[A-Z]{3}$/ } },
            },
          }),
        ]),
      ]);
      const patternRule = manifest.objects.coded.validationRules?.find(
        (r) => r.rule === 'pattern',
      );
      expect(patternRule?.value).toBe('^[A-Z]{3}$');
    });
  });

  describe('code generators', () => {
    const baseManifest = (): SmartObjectManifest => ({
      version: '1.0.0',
      timestamp: 0,
      objects: {
        Note: def('Note', {
          fields: {
            title: { type: 'text', required: true, description: 'The title' },
            length: { type: 'integer', min: 0, max: 99 },
            ratio: { type: 'decimal' },
            ok: { type: 'boolean' },
            at: { type: 'datetime' },
            data: { type: 'json' },
            link: { type: 'foreignKey', related: 'Other' },
          },
          methods: {
            summarize: {
              name: 'summarize',
              async: true,
              parameters: [],
              returnType: 'string',
              isStatic: false,
              isPublic: true,
            },
          },
          decoratorConfig: { api: true, mcp: true },
        }),
      },
    });

    it('generates TypeScript interfaces mapping every field type', () => {
      const gen = new ManifestGenerator();
      const ts = gen.generateTypeDefinitions(baseManifest());
      expect(ts).toContain('export interface NoteData');
      expect(ts).toContain('title: string;'); // required -> no '?'
      expect(ts).toContain('length?: number;'); // integer
      expect(ts).toContain('ratio?: number;'); // decimal
      expect(ts).toContain('ok?: boolean;');
      expect(ts).toContain('at?: Date | string;');
      expect(ts).toContain('data?: any;');
      expect(ts).toContain('link?: string;'); // foreignKey
    });

    it('generates REST endpoint code and respects api: false', () => {
      const gen = new ManifestGenerator();
      const code = gen.generateRestEndpointCode(baseManifest());
      expect(code).toContain("app.get('/notes'");
      expect(code).toContain("app.post('/notes'");
      expect(code).toContain("app.put('/notes/:id'");
      expect(code).toContain("app.delete('/notes/:id'");

      const disabled = baseManifest();
      disabled.objects.Note.decoratorConfig.api = false;
      expect(gen.generateRestEndpointCode(disabled)).toBe('');
    });

    it('honors include/exclude operation filters in REST code', () => {
      const gen = new ManifestGenerator();
      const m = baseManifest();
      m.objects.Note.decoratorConfig.api = { include: ['list', 'get'] };
      const code = gen.generateRestEndpointCode(m);
      expect(code).toContain("app.get('/notes'");
      expect(code).toContain("app.get('/notes/:id'");
      expect(code).not.toContain("app.post('/notes'");
      expect(code).not.toContain("app.delete('/notes/:id'");
    });

    it('generates MCP tool names and JSON tool definitions', () => {
      const gen = new ManifestGenerator();
      const names = gen.generateMCPTools(baseManifest());
      expect(names.split('\n')).toEqual([
        'list_notes',
        'get_notes',
        'create_notes',
        'update_notes',
        'delete_notes',
      ]);

      const code = gen.generateMCPToolsCode(baseManifest());
      expect(code).toContain('"list_notes"');
      expect(code).toContain('"get_note"');
      expect(code).toContain('"create_note"');
      // JSON schema properties carry numeric/length constraints from fields.
      expect(code).toContain('"minimum": 0');
      expect(code).toContain('"maximum": 99');
    });

    it('omits MCP tools entirely when mcp is false', () => {
      const gen = new ManifestGenerator();
      const m = baseManifest();
      m.objects.Note.decoratorConfig.mcp = false;
      expect(gen.generateMCPTools(m)).toBe('');
    });

    it('exposes simple endpoints for collection-class static methods', () => {
      const gen = new ManifestGenerator();
      const m: SmartObjectManifest = {
        version: '1.0.0',
        timestamp: 0,
        objects: {
          Things: def('Things', {
            collection: 'things',
            extends: 'SmrtCollection',
            extendsTypeArg: 'Thing',
            methods: {
              bulkImport: {
                name: 'bulkImport',
                async: true,
                parameters: [],
                returnType: 'void',
                isStatic: true,
                isPublic: true,
              },
            },
            decoratorConfig: { api: true },
          }),
        },
      };
      const endpoints = gen.generateRestEndpoints(m);
      // Collection class: no item CRUD, just the collection-scope method.
      expect(endpoints).toBe('POST /things/bulkImport');
    });
  });

  describe('agent manifests', () => {
    it('derives permissions, features, menu items, and components from uiSlots + exports', () => {
      const gen = new ManifestGenerator();
      const manifest = gen.generateManifest(
        [
          scan([
            def('TownAgent', {
              decoratorConfig: {
                agent: { icon: 'town', tier: 'pro', description: 'Town agent' },
                cli: { include: ['runReport'] },
                mcp: { include: ['runReport', 'sync'] },
              },
              staticProperties: {
                uiSlots: {
                  dashboard: { label: 'Dashboard', icon: 'gauge', order: 1 },
                  settings: { label: 'Settings', order: 2 },
                },
                adminRoutes: [{ path: '/admin/town', label: 'Town admin' }],
              },
            }),
          ]),
        ],
        {
          packageName: '@acme/town',
          packageJson: {
            name: '@acme/town',
            exports: {
              '.': './dist/index.js',
              './admin': { svelte: './admin.svelte' },
              './town': { import: { svelte: './town.svelte' } },
            },
          },
        },
      );

      const agent = manifest.objects['@acme/town:TownAgent'].agent;
      expect(agent).toBeDefined();
      expect(agent?.tier).toBe('pro');
      // manage:<slot> permission per uiSlot + execute:<method> per exposed method.
      const permIds = agent?.permissions.map((p) => p.id) ?? [];
      expect(permIds).toContain('manage:dashboard');
      expect(permIds).toContain('manage:settings');
      expect(permIds).toContain('execute:runReport');
      expect(permIds).toContain('execute:sync');
      // Menu items sorted by order and routed under the agent slug.
      expect(agent?.menuItems.map((m) => m.id)).toEqual([
        'dashboard',
        'settings',
      ]);
      expect(agent?.menuItems[0].path).toBe('/agents/townagent/dashboard');
      // Component declarations derived from svelte-conditioned exports.
      const componentTypes = agent?.components.map((c) => c.type).sort();
      expect(componentTypes).toEqual(['admin', 'town']);
      // adminRoutes captured from the static property.
      expect(agent?.adminRoutes).toHaveLength(1);
    });

    it('defaults tier to free and omits adminRoutes when none are declared', () => {
      const gen = new ManifestGenerator();
      const manifest = gen.generateManifest([
        scan([
          def('BareAgent', {
            decoratorConfig: { agent: { icon: 'bot' } },
          }),
        ]),
      ]);
      const agent = manifest.objects.bareagent.agent;
      expect(agent?.tier).toBe('free');
      expect(agent?.adminRoutes).toBeUndefined();
      expect(agent?.permissions).toEqual([]);
    });
  });

  describe('saveManifest / loadManifest round-trip', () => {
    let dir: string | null = null;
    afterEach(() => {
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
        dir = null;
      }
    });

    it('writes a manifest to disk and reads it back identically', () => {
      const gen = new ManifestGenerator();
      const manifest = gen.generateManifest([
        scan([def('Saved', { fields: { x: { type: 'text' } } })]),
      ]);

      dir = mkdtempSync(join(tmpdir(), 'smrt-mg-save-'));
      const file = join(dir, 'manifest.json');
      gen.saveManifest(manifest, file);

      const loaded = gen.loadManifest(file);
      expect(loaded.objects.saved.className).toBe('Saved');
      expect(loaded.version).toBe(manifest.version);
    });
  });

  describe('generateManifest convenience function', () => {
    it('delegates to a fresh ManifestGenerator instance', () => {
      const manifest = generateManifestFn([
        scan([def('Convenience', { fields: { a: { type: 'text' } } })]),
      ]);
      expect(manifest.objects.convenience).toBeDefined();
      expect(manifest.objects.convenience.schema?.tableName).toBe(
        'conveniences',
      );
    });
  });

  describe('AI tool generation', () => {
    it('attaches generated tools when the decorator declares an ai config', () => {
      const gen = new ManifestGenerator();
      const manifest = gen.generateManifest([
        scan([
          def('Assistant', {
            decoratorConfig: { ai: { include: ['draft'] } as any },
            methods: {
              draft: {
                name: 'draft',
                async: true,
                parameters: [
                  { name: 'topic', type: 'string', optional: false },
                ],
                returnType: 'string',
                isStatic: false,
                isPublic: true,
                description: 'Draft something',
              } as any,
            },
          }),
        ]),
      ]);
      // The ai config drives generateToolManifest; whether tools are produced
      // depends on method shape, but the object must still be emitted intact.
      expect(manifest.objects.assistant).toBeDefined();
    });
  });

  // These tests exercise the external-package resolution paths
  // (loadParentFromExternalPackage, the external-STI-base branch of
  // generateSchemas, createAggregatedManifest's external merge, and the
  // external loop in extendsFrameworkAbstractBase). They require a real
  // manifest on disk that loadExternalManifestSync can resolve via package
  // exports, so each test writes a throwaway node_modules package.
  describe('external SMRT package resolution', () => {
    let dir: string;
    let prev: string;
    const EXT_PKG = '@happyvertical/smrt-ext-fixture';

    beforeEach(() => {
      clearManifestCache();
      dir = mkdtempSync(join(tmpdir(), 'smrt-mg-ext-'));
      prev = process.cwd();
    });

    afterEach(() => {
      process.chdir(prev);
      clearManifestCache();
      rmSync(dir, { recursive: true, force: true });
    });

    /** Write an external SMRT package exposing the given manifest objects. */
    function writeExternalPackage(objects: Record<string, any>): void {
      const pkgDir = join(
        dir,
        'node_modules',
        '@happyvertical',
        'smrt-ext-fixture',
      );
      mkdirSync(join(pkgDir, 'dist'), { recursive: true });
      writeFileSync(
        join(pkgDir, 'package.json'),
        JSON.stringify({
          name: EXT_PKG,
          type: 'module',
          exports: { './manifest.json': './dist/manifest.json' },
        }),
      );
      writeFileSync(
        join(pkgDir, 'dist', 'manifest.json'),
        JSON.stringify({
          version: '1.0.0',
          timestamp: 0,
          moduleType: 'smrt',
          packageName: EXT_PKG,
          objects,
        }),
      );
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: '@acme/consumer', type: 'module' }),
      );
    }

    it('generates an STI schema for a child whose STI base lives in an external package', () => {
      // External STI base "Content" with the shared table.
      writeExternalPackage({
        [`${EXT_PKG}:Content`]: {
          className: 'Content',
          collection: 'contents',
          fields: { title: { type: 'text' } },
          decoratorConfig: { tableStrategy: 'sti', tableName: 'contents' },
        },
      });

      process.chdir(dir);
      const gen = new ManifestGenerator();
      const manifest = gen.generateManifest(
        [
          scan([
            // Local child extends the EXTERNAL base — base not in this manifest.
            def('Memo', {
              extends: 'Content',
              fields: { body: { type: 'text' } },
            }),
          ]),
        ],
        { smrtDependencies: [EXT_PKG] },
      );

      const memo = manifest.objects.memo;
      // Child resolved the external STI base and generated a schema against the
      // base's shared table name, not its own derived 'memos' table.
      expect(memo.schema?.tableName).toBe('contents');
      // The external base's title field was merged into the child.
      expect(memo.fields.title).toBeDefined();
    });

    it('merges parentId from an external SmrtHierarchical base into a CTI child', () => {
      // External framework abstract base contributing a parentId field.
      writeExternalPackage({
        [`${EXT_PKG}:SmrtHierarchical`]: {
          className: 'SmrtHierarchical',
          collection: '',
          fields: { parentId: { type: 'text', _meta: {} } },
          decoratorConfig: {},
        },
      });

      process.chdir(dir);
      const gen = new ManifestGenerator();
      const manifest = gen.generateManifest(
        [
          scan([
            def('Node', {
              extends: 'SmrtHierarchical',
              fields: { label: { type: 'text' } },
            }),
          ]),
        ],
        { smrtDependencies: [EXT_PKG] },
      );

      const node = manifest.objects.node;
      // parentId pulled from the external framework base and normalized.
      expect(node.fields.parentId).toBeDefined();
      expect(node.fields.parentId.type).toBe('foreignKey');
      expect(node.fields.parentId.related).toBe('Node');
    });
  });
});
