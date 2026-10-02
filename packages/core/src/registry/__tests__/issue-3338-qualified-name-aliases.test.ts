/**
 * Deprecated qualified-name aliases (#3338).
 *
 * A class that moves package declares its old qualified names in
 * `@smrt({ previousQualifiedNames })`. These tests drive the registry from
 * manifest fixtures (the shape a consumer process sees for an installed
 * package) and prove:
 *
 * - eager resolution: every qualified lookup resolves an old name to the class;
 * - lazy resolution: an old package identity resolves through the NEW owner's
 *   manifest even when nothing registered the class yet;
 * - `@crossPackageRef` / relationship targets and playbook model names by the
 *   old name resolve to the current class;
 * - the deprecation warning fires once per old name;
 * - the alias is never a second class (no key, table, tool, or surface);
 * - collisions with a live class or a second claimant are clear errors;
 * - the scanner carries the option through manifest, knowledge, and back
 *   into the registry.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InheritanceResolver,
  ManifestAdapter,
  parseSource,
} from '@happyvertical/smrt-scanner';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MCPGenerator } from '../../generators/mcp.js';
import { resolveRegisteredObjectName } from '../../generators/preflight-route.js';
import { buildDomainKnowledgeManifest } from '../../knowledge.js';
import { getManifestCache } from '../../manifest/store.js';
import { SmrtObject } from '../../object.js';
import { ObjectRegistry } from '../../registry.js';
import { ManifestGenerator } from '../../scanner/manifest-generator.js';
import type {
  FieldDefinition,
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../../scanner/types.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';
import {
  QUALIFIED_NAME_ALIAS_COLLISION,
  QUALIFIED_NAME_ALIAS_DEPRECATED,
  QUALIFIED_NAME_ALIAS_INVALID,
} from '../qualified-name-aliases.js';

const NEW_PKG = '@test-3338/new-owner';
const OLD_PKG = '@test-3338/old-owner';
const RIVAL_PKG = '@test-3338/rival-owner';
const CURRENT = `${NEW_PKG}:MovedThing`;
const OLD = `${OLD_PKG}:MovedThing`;

function objectDef(
  className: string,
  packageName: string,
  options: {
    fields?: Record<string, FieldDefinition>;
    decoratorConfig?: SmartObjectDefinition['decoratorConfig'];
  } = {},
): SmartObjectDefinition {
  const table = `t3338_${className.toLowerCase()}s`;
  return {
    name: className.toLowerCase(),
    className,
    qualifiedName: `${packageName}:${className}`,
    collection: `${className.toLowerCase()}s`,
    filePath: `${packageName.replace(/^@/, '')}/src/${className}.ts`,
    packageName,
    fields: options.fields ?? { label: { type: 'text', required: false } },
    methods: {},
    decoratorConfig: { tableName: table, ...(options.decoratorConfig ?? {}) },
    exportName: className,
    collectionExportName: `${className}Collection`,
  } as SmartObjectDefinition;
}

const MOVED = objectDef('MovedThing', NEW_PKG, {
  decoratorConfig: { previousQualifiedNames: [OLD] },
});

const REFERRER = objectDef('Referrer', NEW_PKG, {
  fields: {
    movedId: {
      type: 'crossPackageRef',
      related: OLD,
      required: false,
    } as FieldDefinition,
  },
});

function register(def: SmartObjectDefinition): void {
  ObjectRegistry.registerFromManifest(
    def.qualifiedName ?? def.className,
    def,
    def.packageName ?? '',
  );
}

function deprecationDiagnostics() {
  return ObjectRegistry.getDiagnostics().filter(
    (diagnostic) => diagnostic.code === QUALIFIED_NAME_ALIAS_DEPRECATED,
  );
}

describe('issue #3338: deprecated qualified-name aliases', () => {
  let restoreRegistry: () => void;

  beforeEach(() => {
    restoreRegistry = snapshotObjectRegistryState();
    ObjectRegistry.clear();
    ObjectRegistry.clearDiagnostics();
  });

  afterEach(() => {
    getManifestCache().delete(NEW_PKG);
    getManifestCache().delete(RIVAL_PKG);
    getManifestCache().delete(OLD_PKG);
    ObjectRegistry.clearDiagnostics();
    restoreRegistry();
  });

  describe('eager resolution', () => {
    beforeEach(() => {
      register(MOVED);
      register(REFERRER);
    });

    it('resolves the old name through every qualified lookup', () => {
      const current = ObjectRegistry.getClassByQualifiedName(CURRENT);
      expect(current?.qualifiedName).toBe(CURRENT);

      expect(ObjectRegistry.getClassByQualifiedName(OLD)).toBe(current);
      expect(ObjectRegistry.getClass(OLD)).toBe(current);
      expect(ObjectRegistry.hasClass(OLD)).toBe(true);
      expect(ObjectRegistry.getClassInPackage(OLD_PKG, 'MovedThing')).toBe(
        current,
      );
      expect(ObjectRegistry.resolveType(OLD)).toBe(CURRENT);
      expect(ObjectRegistry.getTableName(OLD)).toBe('t3338_movedthings');
      expect([...ObjectRegistry.getFields(OLD).keys()]).toContain('label');
    });

    it('exposes the alias map and the current/equivalent names', () => {
      expect([...ObjectRegistry.getQualifiedNameAliases()]).toEqual([
        [OLD, CURRENT],
      ]);
      expect(ObjectRegistry.resolveQualifiedName(OLD)).toBe(CURRENT);
      expect(ObjectRegistry.resolveQualifiedName(CURRENT)).toBe(CURRENT);
      expect(ObjectRegistry.resolveQualifiedName('MovedThing')).toBeUndefined();
      expect(
        ObjectRegistry.resolveQualifiedName(`${OLD_PKG}:Nope`),
      ).toBeUndefined();
      expect(ObjectRegistry.getEquivalentQualifiedNames(CURRENT)).toEqual([
        CURRENT,
        OLD,
      ]);
      expect(ObjectRegistry.getEquivalentQualifiedNames(OLD)).toEqual([
        CURRENT,
        OLD,
      ]);
      expect(ObjectRegistry.getEquivalentQualifiedNames('MovedThing')).toEqual([
        'MovedThing',
      ]);
    });

    it('resolves a @crossPackageRef declared by the old name to the current class', () => {
      expect(
        ObjectRegistry.resolveRelationshipTarget(
          `${NEW_PKG}:Referrer`,
          'movedId',
        ),
      ).toBe(CURRENT);
      const [relationship] = ObjectRegistry.getRelationships(
        `${NEW_PKG}:Referrer`,
      );
      expect(relationship.targetClass).toBe(OLD);
      expect(relationship.targetQualifiedClass).toBe(CURRENT);
      expect(
        ObjectRegistry.getInverseRelationshipsForSelf(CURRENT).map(
          (inverse) => `${inverse.sourceQualifiedClass}.${inverse.fieldName}`,
        ),
      ).toContain(`${NEW_PKG}:Referrer.movedId`);
    });

    it('resolves a playbook step model named by the old name', () => {
      expect(resolveRegisteredObjectName(OLD)).toBe('MovedThing');
    });

    it('warns once per old name, naming old, new, and the resolution site', () => {
      ObjectRegistry.getClassByQualifiedName(OLD, { source: 'test site' });
      ObjectRegistry.getClassByQualifiedName(OLD);
      ObjectRegistry.getClass(OLD);
      ObjectRegistry.resolveType(OLD);

      const warnings = deprecationDiagnostics();
      expect(warnings).toHaveLength(1);
      expect(warnings[0].severity).toBe('warn');
      expect(warnings[0].context).toEqual({
        alias: OLD,
        current: CURRENT,
        source: 'test site',
      });
      expect(warnings[0].message).toContain(OLD);
      expect(warnings[0].message).toContain(CURRENT);

      // Lookups by the current name never warn.
      ObjectRegistry.clearDiagnostics();
      ObjectRegistry.getClassByQualifiedName(CURRENT);
      ObjectRegistry.getClass(CURRENT);
      expect(deprecationDiagnostics()).toHaveLength(0);
    });

    it('never makes the alias a second class: no key, table, tool, or surface', async () => {
      const keys = [...ObjectRegistry.getAllClasses().keys()];
      expect(keys).not.toContain(OLD);
      expect(keys.filter((key) => key.endsWith(':MovedThing'))).toEqual([
        CURRENT,
      ]);
      expect(ObjectRegistry.getQualifiedClassNames()).toEqual([
        CURRENT,
        `${NEW_PKG}:Referrer`,
      ]);
      expect(ObjectRegistry.getClassesByPackage(OLD_PKG).size).toBe(0);
      expect(ObjectRegistry.findClassesByName('MovedThing')).toHaveLength(1);

      const schemas = await ObjectRegistry.getAllSchemasAsDefinitions();
      const tables = Object.values(schemas).map((schema) => schema.tableName);
      expect(tables.filter((table) => table === 't3338_movedthings')).toEqual([
        't3338_movedthings',
      ]);

      const toolNames = (await new MCPGenerator().generateTools()).map(
        (tool) => tool.name,
      );
      expect(new Set(toolNames).size).toBe(toolNames.length);
      expect(
        toolNames.filter((name) => name === 'movedthing_list'),
      ).toHaveLength(1);

      const rootDir = mkdtempSync(join(tmpdir(), 'smrt-3338-knowledge-'));
      try {
        const artifact = buildDomainKnowledgeManifest({
          manifest: {
            version: '1.0.0',
            timestamp: 0,
            packageName: NEW_PKG,
            packageVersion: '1.0.0',
            objects: { [CURRENT]: MOVED },
          },
          rootDir,
          packageJson: { name: NEW_PKG, version: '1.0.0' },
        });
        expect(artifact.objects.map((object) => object.qualifiedName)).toEqual([
          CURRENT,
        ]);
        expect(artifact.objects[0].previousQualifiedNames).toEqual([OLD]);
        expect(
          artifact.surfaces.some((surface) => surface.objectName === OLD),
        ).toBe(false);
        const routes = artifact.surfaces.map(
          (surface) => `${surface.kind}:${surface.name}`,
        );
        expect(new Set(routes).size).toBe(routes.length);
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }
    });
  });

  describe('collisions', () => {
    function expectCode(fn: () => void, code: string) {
      let thrown: unknown;
      try {
        fn();
      } catch (error) {
        thrown = error;
      }
      expect(thrown, 'expected a ConfigurationError').toBeDefined();
      expect((thrown as { code?: string }).code).toBe(code);
    }

    it('refuses an alias that names a live class (alias declared second)', () => {
      register(objectDef('StillLive', OLD_PKG));
      expectCode(
        () =>
          register(
            objectDef('Successor', NEW_PKG, {
              decoratorConfig: {
                previousQualifiedNames: [`${OLD_PKG}:StillLive`],
              },
            }),
          ),
        QUALIFIED_NAME_ALIAS_COLLISION,
      );
    });

    it('refuses a live class registered under an existing alias (alias declared first)', () => {
      register(
        objectDef('Successor', NEW_PKG, {
          decoratorConfig: {
            previousQualifiedNames: [`${OLD_PKG}:StillLive`],
          },
        }),
      );
      expectCode(
        () => register(objectDef('StillLive', OLD_PKG)),
        QUALIFIED_NAME_ALIAS_COLLISION,
      );
    });

    it('refuses the old package still shipping the moved class under its old name', () => {
      register(MOVED);
      expectCode(
        () => register(objectDef('MovedThing', OLD_PKG)),
        QUALIFIED_NAME_ALIAS_COLLISION,
      );
    });

    it('refuses one old name claimed by two classes', () => {
      register(MOVED);
      expectCode(
        () =>
          register(
            objectDef('OtherThing', NEW_PKG, {
              decoratorConfig: { previousQualifiedNames: [OLD] },
            }),
          ),
        QUALIFIED_NAME_ALIAS_COLLISION,
      );
    });

    it('refuses an unscoped alias, which qualified lookups never treat as qualified', () => {
      // `isQualifiedName()` — the predicate eager lookups, resolveType() and
      // the lazy loader all use — requires an `@scope/` package, so an
      // unscoped old name could never resolve. Refuse it up front.
      expectCode(
        () =>
          register(
            objectDef('Unscoped', NEW_PKG, {
              decoratorConfig: { previousQualifiedNames: ['old-app:Unscoped'] },
            }),
          ),
        QUALIFIED_NAME_ALIAS_INVALID,
      );
    });

    it('refuses an alias with a colon in its package part', () => {
      // Qualified names split at the LAST colon, so the package here would
      // be `@scope/pkg:legacy` — no package the lazy loader could resolve.
      expectCode(
        () =>
          register(
            objectDef('ExtraColon', NEW_PKG, {
              decoratorConfig: {
                previousQualifiedNames: ['@scope/pkg:legacy:ExtraColon'],
              },
            }),
          ),
        QUALIFIED_NAME_ALIAS_INVALID,
      );
    });

    it('validates a same-key re-registration before mutating the live entry', () => {
      class ReRegistered extends SmrtObject {}
      const key = `${NEW_PKG}:ReRegistered`;
      ObjectRegistry.register(ReRegistered as unknown as typeof SmrtObject, {
        packageName: NEW_PKG,
        tableName: 't3338_reregistered',
      });
      register(objectDef('StillLive', OLD_PKG));
      const entry = ObjectRegistry.getAllClasses().get(key);
      expect(entry).toBeDefined();
      const configBefore = structuredClone(entry?.config);

      for (const [aliases, code] of [
        [['NotQualified'], QUALIFIED_NAME_ALIAS_INVALID],
        [[`${OLD_PKG}:StillLive`], QUALIFIED_NAME_ALIAS_COLLISION],
      ] as const) {
        expectCode(
          () =>
            ObjectRegistry.register(
              ReRegistered as unknown as typeof SmrtObject,
              {
                packageName: NEW_PKG,
                tableName: 't3338_reregistered',
                previousQualifiedNames: [...aliases],
              },
            ),
          code,
        );
        expect(ObjectRegistry.getAllClasses().get(key)).toBe(entry);
        expect(entry?.config).toEqual(configBefore);
      }
      expect(ObjectRegistry.getQualifiedNameAliases().size).toBe(0);
    });

    it('validates a manifest merge before mutating the live entry', () => {
      class MergeTarget extends SmrtObject {}
      const key = `${NEW_PKG}:MergeTarget`;
      ObjectRegistry.register(MergeTarget as unknown as typeof SmrtObject, {
        packageName: NEW_PKG,
        tableName: 't3338_mergetargets',
      });
      const entry = ObjectRegistry.getAllClasses().get(key);
      const configBefore = structuredClone(entry?.config);
      const fieldsBefore = [...(entry?.fields.keys() ?? [])];

      expectCode(
        () =>
          register(
            objectDef('MergeTarget', NEW_PKG, {
              fields: { extra: { type: 'text', required: false } },
              decoratorConfig: { previousQualifiedNames: ['NotQualified'] },
            }),
          ),
        QUALIFIED_NAME_ALIAS_INVALID,
      );
      expect(ObjectRegistry.getAllClasses().get(key)).toBe(entry);
      expect(entry?.config).toEqual(configBefore);
      expect([...(entry?.fields.keys() ?? [])]).toEqual(fieldsBefore);
    });

    it('refuses malformed declarations', () => {
      expectCode(
        () =>
          register(
            objectDef('BadFormat', NEW_PKG, {
              decoratorConfig: { previousQualifiedNames: ['NotQualified'] },
            }),
          ),
        QUALIFIED_NAME_ALIAS_INVALID,
      );
      expectCode(
        () =>
          register(
            objectDef('SelfAlias', NEW_PKG, {
              decoratorConfig: {
                previousQualifiedNames: [`${NEW_PKG}:SelfAlias`],
              },
            }),
          ),
        QUALIFIED_NAME_ALIAS_INVALID,
      );
      expectCode(
        () =>
          register(
            objectDef('NotArray', NEW_PKG, {
              decoratorConfig: {
                previousQualifiedNames: OLD as unknown as string[],
              },
            }),
          ),
        QUALIFIED_NAME_ALIAS_INVALID,
      );
    });
  });

  describe('lazy manifest-loading path', () => {
    it('resolves an old package identity through the new owner manifest alias index', async () => {
      // The old package is not installed and nothing registered the class:
      // only the NEW owner's (cached) manifest knows the old name.
      getManifestCache().set(NEW_PKG, {
        version: '1.0.0',
        timestamp: 0,
        packageName: NEW_PKG,
        objects: { [CURRENT]: MOVED },
      });
      expect(ObjectRegistry.getClassByQualifiedName(OLD)).toBeUndefined();

      await expect(
        ObjectRegistry.tryLoadFromExternalPackage(OLD),
      ).resolves.toBe(true);

      const registered = ObjectRegistry.getClassByQualifiedName(OLD);
      expect(registered?.qualifiedName).toBe(CURRENT);
      expect([...ObjectRegistry.getAllClasses().keys()]).toEqual([CURRENT]);
      await expect(
        ObjectRegistry.ensureManifestLoaded(OLD),
      ).resolves.toBeUndefined();

      const warnings = deprecationDiagnostics();
      expect(warnings).toHaveLength(1);
      expect(warnings[0].context).toMatchObject({
        alias: OLD,
        current: CURRENT,
        source: 'manifest alias index (lazy load)',
      });
    });

    it('refuses an old name claimed by two manifests when neither owner is registered', async () => {
      getManifestCache().set(NEW_PKG, {
        version: '1.0.0',
        timestamp: 0,
        packageName: NEW_PKG,
        objects: { [CURRENT]: MOVED },
      });
      const rival = objectDef('MovedThing', RIVAL_PKG, {
        decoratorConfig: { previousQualifiedNames: [OLD] },
      });
      getManifestCache().set(RIVAL_PKG, {
        version: '1.0.0',
        timestamp: 0,
        packageName: RIVAL_PKG,
        objects: { [`${RIVAL_PKG}:MovedThing`]: rival },
      });

      await expect(
        ObjectRegistry.tryLoadFromExternalPackage(OLD),
      ).rejects.toMatchObject({ code: QUALIFIED_NAME_ALIAS_COLLISION });
      expect([...ObjectRegistry.getAllClasses().keys()]).toEqual([]);
    });

    function cacheCompetingClaims(): void {
      getManifestCache().set(NEW_PKG, {
        version: '1.0.0',
        timestamp: 0,
        packageName: NEW_PKG,
        objects: { [CURRENT]: MOVED },
      });
      getManifestCache().set(RIVAL_PKG, {
        version: '1.0.0',
        timestamp: 0,
        packageName: RIVAL_PKG,
        objects: {
          [`${RIVAL_PKG}:MovedThing`]: objectDef('MovedThing', RIVAL_PKG, {
            decoratorConfig: { previousQualifiedNames: [OLD] },
          }),
        },
      });
    }

    for (const order of ['current name first', 'old name first'] as const) {
      it(`refuses competing manifest claims whichever name is loaded first (${order})`, async () => {
        cacheCompetingClaims();
        const [first, second] =
          order === 'current name first' ? [CURRENT, OLD] : [OLD, CURRENT];

        for (const name of [first, second]) {
          await expect(
            ObjectRegistry.resolveQualifiedNameAsync(name),
          ).rejects.toMatchObject({ code: QUALIFIED_NAME_ALIAS_COLLISION });
          expect([...ObjectRegistry.getAllClasses().keys()]).toEqual([]);
        }
        await expect(
          ObjectRegistry.ensureManifestLoaded(CURRENT),
        ).rejects.toMatchObject({ code: QUALIFIED_NAME_ALIAS_COLLISION });
        expect(ObjectRegistry.getClassByQualifiedName(OLD)).toBeUndefined();
      });
    }

    it('refuses an eager registration whose old name another loaded manifest claims', () => {
      cacheCompetingClaims();
      let thrown: unknown;
      try {
        register(MOVED);
      } catch (error) {
        thrown = error;
      }
      expect((thrown as { code?: string })?.code).toBe(
        QUALIFIED_NAME_ALIAS_COLLISION,
      );

      class DecoratedMoved extends SmrtObject {}
      thrown = undefined;
      try {
        ObjectRegistry.register(
          DecoratedMoved as unknown as typeof SmrtObject,
          {
            packageName: NEW_PKG,
            tableName: 't3338_decoratedmoveds',
            previousQualifiedNames: [OLD],
          },
        );
      } catch (error) {
        thrown = error;
      }
      expect((thrown as { code?: string })?.code).toBe(
        QUALIFIED_NAME_ALIAS_COLLISION,
      );
      expect([...ObjectRegistry.getAllClasses().keys()]).toEqual([]);
    });

    function cacheSuccessorAndOldPackage(oldListsClass: boolean): void {
      getManifestCache().set(NEW_PKG, {
        version: '1.0.0',
        timestamp: 0,
        packageName: NEW_PKG,
        objects: { [CURRENT]: MOVED },
      });
      // A stale old package version still DEFINING the class (no aliases),
      // or — the legitimate move — the old package without it.
      const other = objectDef('Unrelated', OLD_PKG);
      getManifestCache().set(OLD_PKG, {
        version: '1.0.0',
        timestamp: 0,
        packageName: OLD_PKG,
        objects: oldListsClass
          ? {
              [OLD]: objectDef('MovedThing', OLD_PKG),
              [`${OLD_PKG}:Unrelated`]: other,
            }
          : { [`${OLD_PKG}:Unrelated`]: other },
      });
    }

    it('refuses a successor whose old name a stale manifest still defines (current name first)', async () => {
      cacheSuccessorAndOldPackage(true);
      await expect(
        ObjectRegistry.resolveQualifiedNameAsync(CURRENT),
      ).rejects.toMatchObject({ code: QUALIFIED_NAME_ALIAS_COLLISION });
      expect(ObjectRegistry.getClassByQualifiedName(CURRENT)).toBeUndefined();
      // The old name then resolves to its own (stale) definition, never to
      // the successor.
      await ObjectRegistry.tryLoadFromExternalPackage(OLD);
      expect(ObjectRegistry.getClassByQualifiedName(OLD)?.qualifiedName).toBe(
        OLD,
      );
    });

    it('refuses a successor whose old name a stale manifest still defines (old name first)', async () => {
      cacheSuccessorAndOldPackage(true);
      await expect(ObjectRegistry.resolveQualifiedNameAsync(OLD)).resolves.toBe(
        OLD,
      );
      await expect(
        ObjectRegistry.resolveQualifiedNameAsync(CURRENT),
      ).rejects.toMatchObject({ code: QUALIFIED_NAME_ALIAS_COLLISION });
      expect(ObjectRegistry.getClassByQualifiedName(OLD)?.qualifiedName).toBe(
        OLD,
      );
    });

    it('still resolves the legitimate move once the old manifest no longer lists the class', async () => {
      cacheSuccessorAndOldPackage(false);
      await expect(
        ObjectRegistry.resolveQualifiedNameAsync(CURRENT),
      ).resolves.toBe(CURRENT);
      await expect(ObjectRegistry.resolveQualifiedNameAsync(OLD)).resolves.toBe(
        CURRENT,
      );
    });

    it('still reports an unknown old name as not loadable', async () => {
      await expect(
        ObjectRegistry.tryLoadFromExternalPackage(`${OLD_PKG}:NeverExisted`),
      ).resolves.toBe(false);
    });
  });

  describe('scanner → manifest → knowledge → registry round trip', () => {
    const SOURCE = `
      import { SmrtObject, smrt } from '@happyvertical/smrt-core';

      @smrt({
        tableName: 't3338_scanned_things',
        previousQualifiedNames: ['${OLD_PKG}:ScannedThing', '${OLD_PKG}:ScannedLegacy'],
      })
      export class ScannedThing extends SmrtObject {
        label = '';
      }
    `;

    function scanToManifest(source: string): SmartObjectManifest {
      const parsed = parseSource(source, 'src/scanned-thing.ts');
      expect(
        parsed.errors.filter((error) => error.severity === 'error'),
      ).toEqual([]);
      const resolver = new InheritanceResolver();
      resolver.addClasses(parsed.classes);
      const manifest = new ManifestAdapter().toManifest(resolver.resolveAll(), {
        packageName: NEW_PKG,
        packageVersion: '1.0.0',
      }) as unknown as SmartObjectManifest;
      new ManifestGenerator().applyGenerationPasses(manifest, {
        packageName: NEW_PKG,
      });
      return manifest;
    }

    it('carries previousQualifiedNames deterministically and resolves it after registration', () => {
      const first = scanToManifest(SOURCE);
      const second = scanToManifest(SOURCE);
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));

      const qualified = `${NEW_PKG}:ScannedThing`;
      const def = first.objects[qualified];
      expect(def.decoratorConfig.previousQualifiedNames).toEqual([
        `${OLD_PKG}:ScannedThing`,
        `${OLD_PKG}:ScannedLegacy`,
      ]);
      expect(Object.keys(first.objects)).toEqual([qualified]);

      const rootDir = mkdtempSync(join(tmpdir(), 'smrt-3338-roundtrip-'));
      try {
        const artifact = buildDomainKnowledgeManifest({
          manifest: first,
          rootDir,
          packageJson: { name: NEW_PKG, version: '1.0.0' },
        });
        expect(artifact.objects[0].previousQualifiedNames).toEqual([
          `${OLD_PKG}:ScannedLegacy`,
          `${OLD_PKG}:ScannedThing`,
        ]);
      } finally {
        rmSync(rootDir, { recursive: true, force: true });
      }

      const restored = JSON.parse(JSON.stringify(def)) as SmartObjectDefinition;
      ObjectRegistry.registerFromManifest(qualified, restored, NEW_PKG);
      expect(
        ObjectRegistry.getClassByQualifiedName(`${OLD_PKG}:ScannedLegacy`)
          ?.qualifiedName,
      ).toBe(qualified);
    });

    it('fails manifest generation on a malformed or colliding alias', () => {
      expect(() =>
        scanToManifest(`
          import { SmrtObject, smrt } from '@happyvertical/smrt-core';
          @smrt({ previousQualifiedNames: ['NoPackage'] })
          export class BadAlias extends SmrtObject {}
        `),
      ).toThrow(/is not a qualified name/);

      expect(() =>
        scanToManifest(`
          import { SmrtObject, smrt } from '@happyvertical/smrt-core';
          @smrt({ previousQualifiedNames: ['old-app:Unscoped'] })
          export class Unscoped extends SmrtObject {}
        `),
      ).toThrow(/is not a qualified name/);

      expect(() =>
        scanToManifest(`
          import { SmrtObject, smrt } from '@happyvertical/smrt-core';
          @smrt({ previousQualifiedNames: ['@scope/pkg:legacy:ExtraColon'] })
          export class ExtraColon extends SmrtObject {}
        `),
      ).toThrow(/is not a qualified name/);

      expect(() =>
        scanToManifest(`
          import { SmrtObject, smrt } from '@happyvertical/smrt-core';
          @smrt({ previousQualifiedNames: ['${NEW_PKG}:LiveSibling'] })
          export class Aliaser extends SmrtObject {}
          @smrt()
          export class LiveSibling extends SmrtObject {}
        `),
      ).toThrow(/names a live object of this package/);

      expect(() =>
        scanToManifest(`
          import { SmrtObject, smrt } from '@happyvertical/smrt-core';
          @smrt({ previousQualifiedNames: ['${OLD_PKG}:Shared'] })
          export class First extends SmrtObject {}
          @smrt({ previousQualifiedNames: ['${OLD_PKG}:Shared'] })
          export class Second extends SmrtObject {}
        `),
      ).toThrow(/is declared by both/);
    });
  });
});
