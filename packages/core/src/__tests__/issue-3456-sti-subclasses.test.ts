import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isChangeFeedSensitiveTable } from '../change-feed-sensitivity.js';
import { SchemaComparer } from '../migrations/differ.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry } from '../registry.js';
import { ManifestGenerator } from '../scanner/manifest-generator.js';
import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types.js';
import { getDDLStrategy } from '../schema/ddl/index.js';
import { SchemaGenerator } from '../schema/generator.js';
import { snapshotObjectRegistryState } from '../test-utils.js';

const pkg = '@test/sti3456';
function fixture(sensitive = false): SmartObjectManifest {
  const root: SmartObjectDefinition = {
    className: 'Calendar3456',
    name: 'calendar3456',
    collection: 'calendars3456',
    packageName: pkg,
    filePath: '/test/Calendar3456.ts',
    fields: { tenantId: { type: 'text' } },
    methods: {},
    decoratorConfig: { tableStrategy: 'sti', tableName: 'calendars_3456' },
  };
  const child: SmartObjectDefinition = {
    className: 'Holiday3456',
    name: 'holiday3456',
    collection: 'holidays3456',
    packageName: pkg,
    filePath: '/test/Holiday3456.ts',
    extends: root.className,
    extendsQualified: `${pkg}:${root.className}`,
    fields: { date: { type: 'text' }, name: { type: 'text' } },
    methods: {},
    decoratorConfig: {
      collection: 'holidays3456',
      conflictColumns: ['tenant_id', 'date', 'name'],
      sensitive,
    },
  };
  return {
    version: '1',
    timestamp: 0,
    objects: {
      [`${pkg}:${root.className}`]: root,
      [`${pkg}:${child.className}`]: child,
    },
  };
}

describe('STI subclass contracts (#3456)', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = snapshotObjectRegistryState();
    ObjectRegistry.clear();
  });
  afterEach(() => restore());

  it('uses the child conflict key instead of the root slug key', () => {
    const manifest = fixture();
    for (const obj of Object.values(manifest.objects))
      ObjectRegistry.registerFromManifest(obj.className, obj, pkg);
    expect(ObjectRegistry.getConflictColumns(`${pkg}:Holiday3456`)).toEqual([
      'tenant_id',
      'date',
      'name',
    ]);
  });
  it('treats an empty child conflict key as the inherited default', () => {
    const manifest = fixture();
    manifest.objects[`${pkg}:Holiday3456`].decoratorConfig!.conflictColumns =
      [];
    const generator = new ManifestGenerator();
    generator.mergeInheritedFields(manifest);
    generator.normalizeConflictColumns(manifest);
    generator.generateSchemas(manifest);
    for (const obj of Object.values(manifest.objects))
      ObjectRegistry.registerFromManifest(obj.className, obj, pkg);
    expect(ObjectRegistry.getConflictColumns(`${pkg}:Holiday3456`)).toEqual(
      ObjectRegistry.getConflictColumns(`${pkg}:Calendar3456`),
    );
    expect(
      ObjectRegistry.getSTIConflictOverrides(`${pkg}:Calendar3456`),
    ).toEqual([]);
    expect(
      manifest.objects[`${pkg}:Calendar3456`].schema!.indexes.filter(
        (index) => index.description === 'STI subclass conflict target',
      ),
    ).toEqual([]);
  });
  it('repairs an old manifest collection from the explicit decorator declaration', () => {
    const manifest = fixture();
    const child = manifest.objects[`${pkg}:Holiday3456`];
    child.collection = 'calendars3456';
    ObjectRegistry.registerFromManifest(child.className, child, pkg);
    expect(ObjectRegistry.getClass(`${pkg}:Holiday3456`)?.collection).toBe(
      'holidays3456',
    );
  });
  it('keeps an explicitly declared child collection while sharing the root table', () => {
    const manifest = fixture();
    new ManifestGenerator().mergeInheritedFields(manifest);
    const child = manifest.objects[`${pkg}:Holiday3456`];
    expect(child.collection).toBe('holidays3456');
    expect(child.decoratorConfig.tableName).toBe('calendars_3456');
  });
  it('refuses a sensitive child of an observable STI root rather than suppressing its siblings', () => {
    const manifest = fixture(true);
    expect(() =>
      new ManifestGenerator().mergeInheritedFields(manifest),
    ).toThrow(/CONFIG_STI_MIXED_SENSITIVITY|mixed.*sensitiv/i);
  });
  for (const reverse of [false, true]) {
    it(`refuses mixed manifest registrations in ${reverse ? 'child-first' : 'root-first'} order`, () => {
      const manifest = fixture(true);
      const objects = Object.values(manifest.objects);
      objects[1].decoratorConfig.tableName = 'calendars_3456';
      objects[1].decoratorConfig.tableStrategy = 'sti';
      if (reverse) objects.reverse();
      ObjectRegistry.registerFromManifest(
        objects[0].className,
        objects[0],
        pkg,
      );
      expect(() =>
        ObjectRegistry.registerFromManifest(
          objects[1].className,
          objects[1],
          pkg,
        ),
      ).toThrow(/mixed sensitivity/);
      expect(isChangeFeedSensitiveTable('calendars_3456')).toBe(true);
    });
  }
  for (const reverse of [false, true]) {
    it(`refuses mixed raw manifests without inherited table metadata (${reverse ? 'child-first' : 'root-first'})`, () => {
      const objects = Object.values(fixture(true).objects);
      if (reverse) objects.reverse();
      ObjectRegistry.registerFromManifest(
        objects[0].className,
        objects[0],
        pkg,
      );
      expect(() =>
        ObjectRegistry.registerFromManifest(
          objects[1].className,
          objects[1],
          pkg,
        ),
      ).toThrow(/mixed sensitivity/);
      expect(isChangeFeedSensitiveTable('calendars_3456')).toBe(true);
    });
  }
  it('permits uniformly sensitive STI classes and preserves the shared table refusal', () => {
    const manifest = fixture(true);
    manifest.objects[`${pkg}:Calendar3456`].decoratorConfig.sensitive = true;
    new ManifestGenerator().mergeInheritedFields(manifest);
    for (const obj of Object.values(manifest.objects))
      ObjectRegistry.registerFromManifest(obj.className, obj, pkg);
    expect(ObjectRegistry.getConfig(`${pkg}:Holiday3456`).sensitive).toBe(true);
  });
  it('honors an explicit runtime collection before a manifest is available', () => {
    class RuntimeCalendar3456 extends SmrtObject {}
    class RuntimeHoliday3456 extends RuntimeCalendar3456 {}
    ObjectRegistry.register(RuntimeCalendar3456, {
      packageName: pkg,
      tableStrategy: 'sti',
      tableName: 'runtime_3456',
    });
    ObjectRegistry.register(RuntimeHoliday3456, {
      packageName: pkg,
      collection: 'runtimeholidays3456',
    });
    expect(
      ObjectRegistry.getClassByConstructor(RuntimeHoliday3456)?.collection,
    ).toBe('runtimeholidays3456');
    ObjectRegistry.register(RuntimeHoliday3456, {
      packageName: pkg,
      collection: 'renamedholidays3456',
    });
    expect(
      ObjectRegistry.getClassByConstructor(RuntimeHoliday3456)?.collection,
    ).toBe('renamedholidays3456');
  });
  it('replaces an external root manifest full index with the complete consumer predicate', () => {
    const manifest = fixture();
    const second = structuredClone(manifest.objects[`${pkg}:Holiday3456`]);
    second.className = 'Observance3456';
    second.name = 'observance3456';
    second.collection = 'observances3456';
    second.decoratorConfig!.collection = 'observances3456';
    manifest.objects[`${pkg}:Observance3456`] = second;
    const generator = new ManifestGenerator();
    generator.mergeInheritedFields(manifest);
    generator.normalizeConflictColumns(manifest);
    generator.generateSchemas(manifest);
    const root = manifest.objects[`${pkg}:Calendar3456`];
    const expected = root.schema!.indexes.find(
      (index) => index.unique && index.where?.includes(' <> '),
    )!;
    // The provider built its root before learning this consumer's subclass.
    root.schema = {
      ...root.schema!,
      indexes: root
        .schema!.indexes.filter((index) => !index.where?.includes(' = '))
        .map((index) =>
          index.name === expected.name
            ? { ...index, where: undefined, description: undefined }
            : index,
        ),
    };
    for (const obj of Object.values(manifest.objects))
      ObjectRegistry.registerFromManifest(obj.className, obj, pkg);
    const merged = ObjectRegistry.getAllSchemasAsDefinitions().calendars_3456;
    expect(
      merged.indexes.find((index) => index.name === expected.name),
    ).toEqual(expected);
  });
  it('emits identical partial keys in registry and manifest schemas, and refuses unsupported DuckDB DDL', async () => {
    const manifest = fixture();
    const generator = new ManifestGenerator();
    generator.mergeInheritedFields(manifest);
    generator.normalizeConflictColumns(manifest);
    generator.generateSchemas(manifest);
    for (const obj of Object.values(manifest.objects))
      ObjectRegistry.registerFromManifest(obj.className, obj, pkg);
    const built = manifest.objects[`${pkg}:Calendar3456`].schema!;
    const runtime = await new SchemaGenerator().generateSTISchemaFromRegistry(
      `${pkg}:Calendar3456`,
      'calendars_3456',
      new Map(),
      {
        conflictColumns: ObjectRegistry.getConflictColumns(
          `${pkg}:Calendar3456`,
        ),
        registry: ObjectRegistry,
      },
    );
    const keys = (indexes: typeof runtime.indexes) =>
      indexes
        .filter((index) => index.unique)
        .map(({ columns, where }) => ({ columns, where }));
    expect(keys(runtime.indexes)).toEqual(keys(built.indexes));
    expect(
      keys(ObjectRegistry.getAllSchemasAsDefinitions().calendars_3456.indexes),
    ).toEqual(keys(runtime.indexes));
    expect(keys(runtime.indexes)).toContainEqual({
      columns: ['tenant_id', 'date', 'name'],
      where: `_meta_type = '${pkg}:Holiday3456'`,
    });
    expect(ObjectRegistry.getConflictPredicate(`${pkg}:Holiday3456`)).toBe(
      `_meta_type = '${pkg}:Holiday3456'`,
    );
    expect(ObjectRegistry.getConflictPredicate(`${pkg}:Calendar3456`)).toBe(
      `_meta_type <> '${pkg}:Holiday3456'`,
    );
    expect(() => getDDLStrategy('duckdb').generateCreateTable(runtime)).toThrow(
      /partial unique indexes/,
    );
    const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    try {
      await expect(
        new SchemaComparer(db, { engineHint: 'duckdb' }).compare({
          calendars_3456: runtime,
        }),
      ).rejects.toThrow(/partial unique indexes/);
      await expect(
        new SchemaComparer(db, { engineHint: 'duckdb' }).compareTable(
          'calendars_3456',
          runtime,
        ),
      ).rejects.toThrow(/partial unique indexes/);
    } finally {
      await db.close?.();
    }
  });
});
