import { afterEach, assert, describe, expect, it, vi } from 'vitest';
import { foreignKey } from '../../decorators/index.js';
import {
  computeSchemaFingerprint,
  tryComputeManifestSchemaFingerprint,
} from '../../migrations/schema-fingerprint.js';
import { SmrtObject } from '../../object.js';
import { ObjectRegistry, smrt } from '../../registry.js';
import { SchemaGenerator } from '../../schema/generator.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';
import { ManifestGenerator } from '../manifest-generator.js';
import type { SmartObjectDefinition, SmartObjectManifest } from '../types.js';

const { dependencies } = vi.hoisted(() => ({
  dependencies: new Map<string, SmartObjectManifest>(),
}));
vi.mock('../../manifest/manifest-loader.js', async (original) => ({
  ...(await original<typeof import('../../manifest/manifest-loader.js')>()),
  loadExternalManifestSync: (name: string) => dependencies.get(name) ?? null,
}));
const APP = '@fk5622/app';
const DOMAIN = '@fk5622/domain.example';
function object(
  packageName: string,
  className: string,
  extra: Partial<SmartObjectDefinition> = {},
): SmartObjectDefinition {
  return {
    name: className.toLowerCase(),
    className,
    qualifiedName: `${packageName}:${className}`,
    packageName,
    collection: `${className.toLowerCase()}s`,
    filePath: `/fixture/${className}.ts`,
    fields: {},
    methods: {},
    decoratorConfig: {},
    extends: 'SmrtObject',
    ...extra,
  };
}
function manifest(
  packageName: string,
  objects: SmartObjectDefinition[],
): SmartObjectManifest {
  return {
    version: '1.0.0',
    timestamp: 0,
    packageName,
    objects: Object.fromEntries(
      objects.map((obj) => [
        obj.qualifiedName ?? `${obj.packageName}:${obj.className}`,
        obj,
      ]),
    ),
  };
}
function hierarchy(packageName: string) {
  return [
    object(packageName, 'Entity', {
      decoratorConfig: {
        tableStrategy: 'sti',
        tableName: 'fk5622_entities',
        idType: 'uuid',
      },
    }),
    object(packageName, 'Party', {
      extends: 'Entity',
      extendsQualified: `${packageName}:Entity`,
    }),
    object(packageName, 'Person', {
      extends: 'Party',
      extendsQualified: `${packageName}:Party`,
    }),
  ];
}
afterEach(() => dependencies.clear());

describe('physical STI foreign key targets (#5622)', () => {
  it.each([
    'local',
    'external',
    'external-dotted',
  ] as const)('keeps %s multilevel target schemas and runtime fingerprints in parity', async (location) => {
    const restore = snapshotObjectRegistryState();
    try {
      const pkg =
        location === 'local'
          ? APP
          : location === 'external'
            ? '@fk5622/domain'
            : DOMAIN;
      const generator = new ManifestGenerator();
      const domain = manifest(pkg, hierarchy(pkg));
      generator.applyGenerationPasses(domain);
      // Published subclasses need not carry a physical schema of their own.
      if (location !== 'local') {
        delete domain.objects[`${pkg}:Person`].schema;
        delete domain.objects[`${pkg}:Party`].schema;
        dependencies.set(pkg, domain);
      }
      const related =
        location === 'local'
          ? 'Person'
          : location === 'external'
            ? `${pkg}:Person`
            : `${pkg}:Person.id`;
      const source = object(APP, 'Subscription', {
        fields: {
          personId: {
            type: 'foreignKey',
            related,
            _meta: {
              onDelete: 'CASCADE',
              onUpdate: 'RESTRICT',
              constraint: { engines: ['sqlite', 'postgres'] },
            },
          },
          opaqueId: {
            type: 'foreignKey',
            related,
            _meta: { constraint: false, sqlType: 'TEXT' },
          },
        },
        decoratorConfig: { tableName: 'fk5622_subscriptions' },
      });
      const build = manifest(
        APP,
        location === 'local'
          ? [...hierarchy(pkg), source]
          : [
              // A same-name local model must never steal the qualified reference.
              object(APP, 'Person', {
                decoratorConfig: { tableName: 'wrong_people', idType: 'text' },
              }),
              source,
            ],
      );
      if (location !== 'local') build.smrtDependencies = [pkg];
      generator.applyGenerationPasses(build);
      class Entity<T = string> extends SmrtObject {
        declare value: T;
      }
      class Party extends Entity {}
      class Person extends Party {}
      class Subscription extends SmrtObject {}
      smrt({
        packageName: pkg,
        tableStrategy: 'sti',
        tableName: 'fk5622_entities',
        idType: 'uuid',
      })(Entity);
      smrt({ packageName: pkg })(Party);
      smrt({ packageName: pkg })(Person);
      foreignKey(related, {
        onDelete: 'CASCADE',
        onUpdate: 'RESTRICT',
        constraint: { engines: ['sqlite', 'postgres'] },
      })(Subscription.prototype, 'personId');
      foreignKey(related, { constraint: false, sqlType: 'TEXT' })(
        Subscription.prototype,
        'opaqueId',
      );
      smrt({ packageName: APP, tableName: 'fk5622_subscriptions' })(
        Subscription,
      );
      const runtime = new SchemaGenerator().generateSchemaFromRegistry(
        `${APP}:Subscription`,
        'fk5622_subscriptions',
        await ObjectRegistry.getAllFields(`${APP}:Subscription`),
        { registry: ObjectRegistry },
      );
      const schema = build.objects[`${APP}:Subscription`].schema;
      assert(schema);
      expect(schema.columns.person_id).toMatchObject({
        type: 'UUID',
        foreignKey: {
          table: 'fk5622_entities',
          column: 'id',
          onDelete: 'CASCADE',
          onUpdate: 'RESTRICT',
          engines: ['sqlite', 'postgres'],
        },
      });
      expect(schema.columns.opaque_id).toMatchObject({ type: 'TEXT' });
      expect(schema.columns.opaque_id.foreignKey).toBeUndefined();
      expect(schema.columns.person_id.foreignKey).toEqual(
        runtime.columns.person_id.foreignKey,
      );
      expect(
        ObjectRegistry.getAllSchemasAsDefinitions().fk5622_subscriptions.columns
          .person_id,
      ).toMatchObject({
        type: 'UUID',
        foreignKey: runtime.columns.person_id.foreignKey,
      });
      for (const engine of ['sqlite', 'postgres', 'duckdb'] as const) {
        const ddl = new SchemaGenerator().generateSQL(runtime, engine);
        expect(ddl).toMatch(
          engine === 'sqlite' ? /"person_id" TEXT/ : /"person_id" uuid/i,
        );
        if (engine !== 'duckdb')
          expect(ddl).toContain('REFERENCES "fk5622_entities"');
        else expect(ddl).not.toContain('REFERENCES "fk5622_entities"');
      }
      expect(computeSchemaFingerprint([runtime])).toBe(
        tryComputeManifestSchemaFingerprint({
          ...build,
          objects: { source: build.objects[`${APP}:Subscription`] },
        }),
      );
    } finally {
      restore();
    }
  });

  it('preserves an explicit column after a dotted qualified package name', () => {
    const build = manifest(APP, [
      object(DOMAIN, 'Person'),
      object(APP, 'Subscription', {
        fields: {
          personId: { type: 'foreignKey', related: `${DOMAIN}:Person.id` },
        },
      }),
    ]);
    new ManifestGenerator().applyGenerationPasses(build);
    expect(
      build.objects[`${APP}:Subscription`].schema?.columns.person_id.foreignKey,
    ).toMatchObject({ table: 'people', column: 'id' });
  });

  it('does not guess a table for a known external descendant whose physical ancestor is missing', () => {
    dependencies.set(
      DOMAIN,
      manifest(DOMAIN, [
        object(DOMAIN, 'Person', {
          extends: 'Entity',
          extendsQualified: `${DOMAIN}:Entity`,
        }),
      ]),
    );
    const build = manifest(APP, [
      object(APP, 'Person'),
      object(APP, 'Subscription', {
        fields: {
          personId: { type: 'foreignKey', related: `${DOMAIN}:Person` },
        },
      }),
    ]);
    build.smrtDependencies = [DOMAIN];
    new ManifestGenerator().applyGenerationPasses(build);
    expect(
      build.objects[`${APP}:Subscription`].schema?.columns.person_id.foreignKey,
    ).toBeUndefined();
  });

  it('retains explicit physical-table references shared by STI descendants', () => {
    const build = manifest(APP, [
      ...hierarchy(APP),
      object(APP, 'Subscription', {
        fields: {
          personId: { type: 'foreignKey', related: 'fk5622_entities.id' },
        },
      }),
    ]);
    new ManifestGenerator().applyGenerationPasses(build);
    expect(
      build.objects[`${APP}:Subscription`].schema?.columns.person_id.foreignKey,
    ).toMatchObject({ table: 'fk5622_entities', column: 'id' });
  });

  it('does not bind an absent qualified target to a same-name or physical-table peer', () => {
    const build = manifest(APP, [
      object(APP, 'Person'),
      object(APP, 'Subscription', {
        fields: {
          personId: { type: 'foreignKey', related: '@missing/domain:Person' },
        },
      }),
    ]);
    new ManifestGenerator().applyGenerationPasses(build);
    expect(
      build.objects[`${APP}:Subscription`].schema?.columns.person_id.foreignKey,
    ).toBeUndefined();
  });

  it('rejects ambiguous simple targets outside the declaring package', () => {
    const build = manifest(APP, [
      object('@a/domain', 'Person'),
      object('@b/domain', 'Person'),
      object(APP, 'Subscription', {
        fields: { personId: { type: 'foreignKey', related: 'Person' } },
      }),
    ]);
    expect(() => new ManifestGenerator().applyGenerationPasses(build)).toThrow(
      /Ambiguous foreign key target/,
    );
  });
});
