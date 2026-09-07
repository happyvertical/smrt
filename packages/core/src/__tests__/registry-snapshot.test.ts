import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ObjectRegistry } from '../registry.js';
import type { SmartObjectDefinition } from '../scanner/types.js';
import {
  assertPlainJson,
  BOOTED_PROVENANCE,
  sanitizeMessagePaths,
  snapshotRegistry,
} from '../system/registry-snapshot.js';

const PROJECT_ROOT = '/srv/app';

function definition(
  overrides: Partial<SmartObjectDefinition> & { className: string },
): SmartObjectDefinition {
  return {
    name: overrides.className.toLowerCase(),
    collection: `${overrides.className.toLowerCase()}s`,
    filePath: `${PROJECT_ROOT}/src/objects/${overrides.className}.ts`,
    fields: {},
    methods: {},
    decoratorConfig: {},
    ...overrides,
  };
}

describe('registry snapshot (#1831)', () => {
  beforeEach(() => {
    ObjectRegistry.clear();
    ObjectRegistry.registerFromManifest(
      'Article',
      definition({
        className: 'Article',
        fields: {
          title: { type: 'text', required: true },
          apiKey: { type: 'text', description: 'secret' },
          author: { type: 'foreignKey', related: 'Author' },
        },
        methods: {
          publish: {
            name: 'publish',
            async: true,
            parameters: [{ name: 'when', type: 'Date', optional: true }],
            returnType: 'Promise<void>',
            isStatic: false,
            isPublic: true,
          },
        },
        decoratorConfig: { api: { exclude: ['delete'] } },
      }),
      '@acme/app',
    );
    ObjectRegistry.registerFromManifest(
      'Author',
      definition({
        className: 'Author',
        filePath: '/opt/node_modules/@acme/people/dist/Author.js',
        fields: { name: { type: 'text' } },
      }),
      '@acme/people',
    );
  });

  afterEach(() => {
    ObjectRegistry.clear();
  });

  it('projects a plain-JSON, sorted snapshot with booted provenance', () => {
    const snapshot = snapshotRegistry({
      projectRoot: PROJECT_ROOT,
      now: new Date('2026-09-07T00:00:00.000Z'),
    });
    expect(() => assertPlainJson(snapshot)).not.toThrow();
    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot);
    expect(snapshot.provenance).toBe(BOOTED_PROVENANCE);
    expect(snapshot.generatedAt).toBe('2026-09-07T00:00:00.000Z');
    expect(snapshot.summary.objectCount).toBe(2);
    expect(snapshot.summary.packages).toEqual([
      { name: '@acme/app', objectCount: 1 },
      { name: '@acme/people', objectCount: 1 },
    ]);
    expect(snapshot.objects.map((o) => o.name)).toEqual(['Article', 'Author']);
  });

  it('never leaks constructors, validators, tool payloads, or field values', () => {
    const snapshot = snapshotRegistry({ projectRoot: PROJECT_ROOT });
    const serialized = JSON.stringify(snapshot);
    for (const forbidden of [
      'constructor',
      'collectionConstructor',
      'validators',
      'validationRules',
      '"tools"',
      '"value"',
      'sourceFilePath',
      'decoratorConfig',
    ]) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
    const article = snapshot.objects[0];
    // Field *names* and types are structural facts; the description of a
    // sensitive field is not projected, and no field ever carries a value.
    expect(article.fields.map((f) => f.name)).toEqual([
      'apiKey',
      'author',
      'title',
    ]);
    expect(serialized).not.toContain('secret');
    expect(article.fields.find((f) => f.name === 'author')?.related).toBe(
      'Author',
    );
    expect(article.methods).toEqual([
      {
        name: 'publish',
        async: true,
        isStatic: false,
        isPublic: true,
        parameters: [{ name: 'when', type: 'Date', optional: true }],
        returnType: 'Promise<void>',
        inherited: false,
      },
    ]);
  });

  it('relativizes project paths and reduces foreign paths to a basename', () => {
    const snapshot = snapshotRegistry({ projectRoot: PROJECT_ROOT });
    const [article, author] = snapshot.objects;
    expect(article.sourceFile).toBe('src/objects/Article.ts');
    expect(author.sourceFile).toBe('Author.js');
    expect(JSON.stringify(snapshot)).not.toContain('/opt/node_modules');
    expect(JSON.stringify(snapshot)).not.toContain(PROJECT_ROOT);
  });

  it('filters objects by simple or qualified name while keeping a global summary', () => {
    const byName = snapshotRegistry({
      projectRoot: PROJECT_ROOT,
      objects: ['Author'],
    });
    expect(byName.summary.objectCount).toBe(2);
    expect(byName.objects.map((o) => o.name)).toEqual(['Author']);
    const byQualified = snapshotRegistry({
      projectRoot: PROJECT_ROOT,
      objects: ['@acme/app:Article'],
    });
    expect(byQualified.objects.map((o) => o.name)).toEqual(['Article']);
  });

  it('omits field and method detail when detail is false', () => {
    const snapshot = snapshotRegistry({
      projectRoot: PROJECT_ROOT,
      detail: false,
    });
    expect(snapshot.objects[0].fields).toEqual([]);
    expect(snapshot.objects[0].fieldCount).toBeGreaterThan(0);
  });

  it('reduces absolute paths inside diagnostic messages', () => {
    expect(
      sanitizeMessagePaths(
        `Package manifest not found at ${PROJECT_ROOT}/node_modules/@acme/people/dist/manifest.json`,
        PROJECT_ROOT,
      ),
    ).toBe(
      'Package manifest not found at node_modules/@acme/people/dist/manifest.json',
    );
    expect(
      sanitizeMessagePaths(
        'Manifest /opt/elsewhere/deps/manifest.json has an invalid shape',
        PROJECT_ROOT,
      ),
    ).toBe('Manifest manifest.json has an invalid shape');
    expect(
      sanitizeMessagePaths(
        'Windows path C:\\deps\\pkg\\manifest.json failed',
        '/srv/app',
      ),
    ).not.toContain('C:\\deps');
    expect(sanitizeMessagePaths('no paths here', PROJECT_ROOT)).toBe(
      'no paths here',
    );
  });

  it('does not mutate the registry', () => {
    const before = ObjectRegistry.getQualifiedClassNames();
    snapshotRegistry({ projectRoot: PROJECT_ROOT });
    expect(ObjectRegistry.getQualifiedClassNames()).toEqual(before);
  });
});
