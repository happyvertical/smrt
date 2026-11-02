/**
 * #4295: static scanning and compiled-runtime registration must infer the
 * same column type for a boolean field.
 *
 * `@field({ required: true, default: false }) importedMarker = false;` scanned
 * as BOOLEAN, but a compiled Node model registered without a build manifest
 * (`ObjectRegistry.getAllSchemasAsDefinitions()`) fell back to TEXT with
 * `defaultValue: false`. The runtime path only sees the decorator options —
 * never the property initializer — so the decorator's boolean `default` is
 * the type evidence both paths must agree on.
 */
import {
  InheritanceResolver,
  ManifestAdapter,
  parseSource,
} from '@happyvertical/smrt-scanner';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { field } from '../decorators/index.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { ManifestGenerator } from '../scanner/manifest-generator.js';
import type { SmartObjectManifest } from '../scanner/types.js';
import { snapshotObjectRegistryState } from '../test-utils.js';
import { getTestDatabase } from '../testing/database.js';

const PKG = '@fixture/issue-4295';

function scanToManifest(source: string): SmartObjectManifest {
  const parsed = parseSource(source, 'src/imported-record.ts');
  expect(parsed.errors.filter((error) => error.severity === 'error')).toEqual(
    [],
  );
  const resolver = new InheritanceResolver();
  resolver.addClasses(parsed.classes);
  const manifest = new ManifestAdapter().toManifest(resolver.resolveAll(), {
    packageName: PKG,
    packageVersion: '1.0.0',
  }) as unknown as SmartObjectManifest;
  new ManifestGenerator().applyGenerationPasses(manifest, {
    packageName: PKG,
  });
  return manifest;
}

/**
 * Static path: the field type and column the build manifest records for
 * `fieldSource` declared on a fresh model.
 */
function staticContract(className: string, fieldSource: string) {
  const manifest = scanToManifest(`
    import { SmrtObject, smrt, field } from '@happyvertical/smrt-core';

    @smrt({ tableName: '${className.toLowerCase()}s' })
    export class ${className} extends SmrtObject {
      ${fieldSource}
    }
  `);
  const def = manifest.objects[`${PKG}:${className}`];
  expect(def).toBeDefined();
  return def;
}

/**
 * Runtime path: register the class the way compiled legacy-decorator output
 * does (`__decorate([field(opts)], Proto, key)`), with no manifest entry, and
 * read the registry's own schema contract.
 */
function runtimeColumn(
  className: string,
  propertyKey: string,
  options: Parameters<typeof field>[0],
) {
  const ctor = { [className]: class extends SmrtObject {} }[className];
  field(options)(ctor.prototype, propertyKey);
  ObjectRegistry.register(ctor, {
    packageName: PKG,
    tableName: `${className.toLowerCase()}s`,
  });
  const registered = ObjectRegistry.getClassByConstructor(ctor);
  const schema =
    ObjectRegistry.getAllSchemasAsDefinitions()[`${className.toLowerCase()}s`];
  const column = schema?.columns[toSnake(propertyKey)];
  return {
    fieldType: registered?.fields.get(propertyKey)?.type,
    column,
    ddl: schema?.ddl ?? '',
    engineDdl: (engine: 'postgres' | 'sqlite') =>
      ObjectRegistry.getAllSchemas(engine)[`${className.toLowerCase()}s`]
        ?.ddl ?? '',
  };
}

function toSnake(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

describe('#4295 boolean field inference parity (static scan vs compiled runtime)', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = snapshotObjectRegistryState();
  });
  afterEach(() => restore());

  it('infers BOOLEAN on both paths for `@field({ required: true, default: false }) x = false`', () => {
    const def = staticContract(
      'ImportedRecord4295',
      '@field({ required: true, default: false })\n      importedMarker = false;',
    );
    expect(def.fields.importedMarker.type).toBe('boolean');

    const runtime = runtimeColumn('ImportedRecord4295', 'importedMarker', {
      required: true,
      default: false,
    });
    expect(runtime.fieldType).toBe('boolean');
    expect(runtime.column?.type).toBe('BOOLEAN');
    expect(runtime.column?.defaultValue).toBe(false);
    expect(runtime.column?.notNull).toBe(true);
    expect(runtime.ddl).toMatch(/imported_marker"?\s+BOOLEAN/i);
    // PostgreSQL stores a native BOOLEAN; SQLite's boolean affinity is 0/1.
    expect(runtime.engineDdl('postgres')).toMatch(
      /imported_marker"?\s+BOOLEAN NOT NULL DEFAULT false/i,
    );
    expect(runtime.engineDdl('sqlite')).toMatch(
      /imported_marker"?\s+INTEGER NOT NULL DEFAULT 0/i,
    );
    for (const engine of ['postgres', 'sqlite'] as const) {
      expect(runtime.engineDdl(engine)).not.toMatch(
        /imported_marker"?\s+TEXT/i,
      );
    }

    // Both paths land on the same column type.
    expect(runtime.fieldType).toBe(def.fields.importedMarker.type);
  });

  it('round-trips a real boolean through a runtime-only model on SQLite', async () => {
    const Imported = class ImportedRow4295 extends SmrtObject {
      importedMarker = false;
    };
    field({ required: true, default: false })(
      Imported.prototype,
      'importedMarker',
    );
    smrt({ packageName: PKG, tableName: 'imported_rows_4295' })(Imported);
    const db = await getTestDatabase({
      classes: [`${PKG}:ImportedRow4295`],
    });
    try {
      const row = await new Imported({ db }).initialize();
      row.importedMarker = true;
      await row.save();
      const fresh = await new Imported({
        db,
        id: row.id ?? undefined,
      }).initialize();
      expect(fresh.importedMarker).toBe(true);
      const [stored] = await db.list('imported_rows_4295', {});
      // SQLite boolean affinity, not the TEXT 'true' the old inference stored.
      expect(stored.imported_marker).toBe(1);
    } finally {
      await db.close?.();
    }
  });

  it('infers BOOLEAN from a `true` default as well', () => {
    const def = staticContract(
      'EnabledRecord4295',
      '@field({ default: true })\n      enabled = true;',
    );
    expect(def.fields.enabled.type).toBe('boolean');
    const runtime = runtimeColumn('EnabledRecord4295', 'enabled', {
      default: true,
    });
    expect(runtime.fieldType).toBe('boolean');
    expect(runtime.column?.type).toBe('BOOLEAN');
    expect(runtime.column?.defaultValue).toBe(true);
  });

  it('infers BOOLEAN statically when the decorator default is the only evidence', () => {
    // No annotation, no initializer: the static scanner used to fall back to
    // TEXT here while the runtime now reads the same `default` as BOOLEAN.
    const def = staticContract(
      'BareFlag4295',
      '@field({ default: false })\n      archived;',
    );
    expect(def.fields.archived.type).toBe('boolean');
    expect(
      runtimeColumn('BareFlag4295', 'archived', { default: false }).fieldType,
    ).toBe('boolean');
  });

  it('lets an explicit `type` win over the default on both paths', () => {
    const def = staticContract(
      'ExplicitText4295',
      "@field({ type: 'text', default: 'false' })\n      legacyFlag = 'false';",
    );
    expect(def.fields.legacyFlag.type).toBe('text');
    expect(
      runtimeColumn('ExplicitText4295', 'legacyFlag', {
        type: 'text',
        default: 'false',
      }).fieldType,
    ).toBe('text');
  });

  it('keeps TEXT for a string default on both paths', () => {
    const def = staticContract(
      'Labelled4295',
      "@field({ default: 'none' })\n      label = 'none';",
    );
    expect(def.fields.label.type).toBe('text');
    expect(
      runtimeColumn('Labelled4295', 'label', { default: 'none' }).fieldType,
    ).toBe('text');
  });

  it('does not guess a numeric column from a runtime number default', () => {
    // `0` and `0.0` are the same JavaScript value, so the runtime cannot apply
    // the source-level integer/decimal rule; it requires an explicit `type`
    // rather than silently choosing INTEGER for a decimal field.
    expect(
      runtimeColumn('Counted4295', 'count', { default: 0 }).fieldType,
    ).toBe('text');
    expect(
      runtimeColumn('Typed4295', 'count', { type: 'integer', default: 0 })
        .fieldType,
    ).toBe('integer');
  });
});
