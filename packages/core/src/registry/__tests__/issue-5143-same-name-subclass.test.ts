/**
 * #5143: a class that extends a class of the same simple name from another
 * package says, in its own `@smrt()` options, whether it replaces that parent
 * (`replaceParent: true`) or is a subtype of it (`replaceParent: false`).
 * Nothing else decides: not which package is the app, not which registered
 * first, not whether the class arrived as a manifest entry or a constructor.
 *
 * Fixture names follow the issue: `@fixture/video:Scene` (the base),
 * `@fixture/histrio:Scene` (the same-named subclass) and
 * `@fixture/video:VideoShot` (a third model with a foreign key to `Scene`).
 * The base is single-table inheritance, as smrt-video's `Scene` is.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { field } from '../../decorators';
import { computeRuntimeWebManifestHash } from '../../generators/rest';
import { clearManifestCache } from '../../manifest/manifest-loader';
import { SmrtObject } from '../../object';
import { ObjectRegistry, smrt } from '../../registry';
import { registerRuntimeModel } from '../../runtime-model.js';
import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../../scanner/types';
import { snapshotObjectRegistryState } from '../../test-utils';
import { getTestDatabase } from '../../testing/database.js';

const VIDEO = '@fixture/video';
const HISTRIO = '@fixture/histrio';
const BASE = `${VIDEO}:Scene`;
const SUB = `${HISTRIO}:Scene`;
const SHOT = `${VIDEO}:VideoShot`;
/** A name the base was registered under before it moved package. */
const OLD = '@fixture/video-legacy:Scene';

type Choice = boolean | undefined;
type Fixture = Omit<SmartObjectDefinition, 'name' | 'collection'> &
  Partial<Pick<SmartObjectDefinition, 'name' | 'collection'>>;

function baseEntry(sti = true): Fixture {
  return {
    className: 'Scene',
    qualifiedName: BASE as never,
    packageName: VIDEO,
    filePath: 'src/models/scene.ts',
    fields: { title: { type: 'text', _meta: {} } },
    methods: {},
    decoratorConfig: {
      ...(sti ? { tableStrategy: 'sti' as const } : {}),
      previousQualifiedNames: [OLD],
    },
  };
}
function shotEntry(): Fixture {
  return {
    className: 'VideoShot',
    qualifiedName: SHOT as never,
    packageName: VIDEO,
    filePath: 'src/models/video-shot.ts',
    fields: { sceneId: { type: 'foreignKey', related: 'Scene', _meta: {} } },
    methods: {},
    decoratorConfig: {},
  };
}
function subEntry(replaceParent: Choice): Fixture {
  return {
    className: 'Scene',
    qualifiedName: SUB as never,
    packageName: HISTRIO,
    extends: 'Scene',
    extendsQualified: BASE,
    filePath: 'src/models/histrio-scene.ts',
    fields: { mood: { type: 'text', _meta: {} } },
    methods: {},
    decoratorConfig: {
      tableStrategy: 'sti',
      ...(replaceParent === undefined ? {} : { replaceParent }),
    },
  };
}

function fromManifest(key: string, entry: Fixture, packageName: string): void {
  ObjectRegistry.registerFromManifest(
    key,
    { name: entry.className.toLowerCase(), collection: 'scenes', ...entry },
    packageName,
  );
}

/**
 * How the subclass's package hands its manifest to the registry: entry by
 * entry, as the CLI loads an app's manifest, or whole through the
 * self-registration a library build ships (which also marks the package as
 * stamping its constructors). The declared choice decides the same either way.
 */
const declarers = {
  app: (entry: Fixture) => fromManifest(SUB, entry, HISTRIO),
  library: (entry: Fixture) => {
    ObjectRegistry.registerPackageManifest({
      version: '1',
      timestamp: 0,
      packageName: HISTRIO,
      stampsConstructors: true,
      objects: {
        [SUB]: {
          name: 'scene',
          collection: 'scenes',
          ...entry,
        } as SmartObjectDefinition,
      },
    } satisfies SmartObjectManifest);
  },
} as const;

const manifestSteps = (
  sub: Fixture,
  declarer: keyof typeof declarers = 'app',
  sti = true,
) => ({
  base: () => fromManifest(BASE, baseEntry(sti), VIDEO),
  shot: () => fromManifest(SHOT, shotEntry(), VIDEO),
  sub: () => declarers[declarer](sub),
});
const ORDERS = [
  ['base', 'shot', 'sub'],
  ['base', 'sub', 'shot'],
  ['sub', 'base', 'shot'],
  ['sub', 'shot', 'base'],
  ['shot', 'sub', 'base'],
] as const;

/** Everything about the pair that must not depend on load order. */
function describeRegistry() {
  const names = (key: string) =>
    ObjectRegistry.getClass(key)?.qualifiedName ?? null;
  return {
    keys: [...ObjectRegistry.getAllClasses().keys()].sort(),
    base: names(BASE),
    baseExact: ObjectRegistry.getClassByQualifiedName(BASE)?.qualifiedName,
    sub: names(SUB),
    alias: ObjectRegistry.getClassByQualifiedName(OLD)?.qualifiedName,
    aliases: [...ObjectRegistry.getQualifiedNameAliases()],
    foreignKey: ObjectRegistry.resolveRelationshipTarget(SHOT, 'sceneId'),
    subChain: ObjectRegistry.getInheritanceChain(SUB),
    subStiBase: ObjectRegistry.getSTIBase(SUB),
    subParent: ObjectRegistry.getClass(SUB)?.extends,
    subReplaced: [
      ...(ObjectRegistry.getClass(SUB)?.replacedQualifiedNames ?? []),
    ].sort(),
    baseFields: [...(ObjectRegistry.getClass(BASE)?.fields.keys() ?? [])],
    resolvedBase: ObjectRegistry.resolveQualifiedName(BASE),
  };
}

const SUBTYPE_REGISTRY = {
  keys: [SUB, BASE, SHOT].sort(),
  base: BASE,
  baseExact: BASE,
  sub: SUB,
  alias: BASE,
  aliases: [[OLD, BASE]],
  foreignKey: BASE,
  subChain: [BASE, SUB],
  subStiBase: BASE,
  subParent: BASE,
  subReplaced: [],
  baseFields: ['title'],
  resolvedBase: BASE,
};
const REPLACED_REGISTRY = {
  keys: [SUB, SHOT].sort(),
  base: SUB,
  baseExact: undefined,
  sub: SUB,
  // The parent's deprecated name follows the replacement.
  alias: SUB,
  aliases: [[OLD, SUB]],
  foreignKey: SUB,
  subChain: [BASE, SUB],
  // The replacement is the family's root: the base resolves to it.
  subStiBase: SUB,
  subParent: BASE,
  subReplaced: [BASE],
  baseFields: ['mood'],
  resolvedBase: SUB,
};

/** Real classes for the constructor path, registered explicitly in any order. */
function constructors(replaceParent: Choice, sti = true) {
  class VideoScene extends SmrtObject {
    title = '';
  }
  class HistrioScene extends VideoScene {
    mood = '';
  }
  class VideoShot extends SmrtObject {
    sceneId = '';
  }
  field({ type: 'text' })(VideoScene.prototype, 'title');
  field({ type: 'text' })(HistrioScene.prototype, 'mood');
  const registrations = {
    base: () =>
      ObjectRegistry.register(VideoScene, {
        name: 'Scene',
        packageName: VIDEO,
        tableName: 'scenes',
        ...(sti ? { tableStrategy: 'sti' as const } : {}),
        previousQualifiedNames: [OLD],
      }),
    shot: () => {
      ObjectRegistry.register(VideoShot, {
        name: 'VideoShot',
        packageName: VIDEO,
        _manifest: {
          version: '1',
          timestamp: 0,
          packageName: VIDEO,
          objects: { [SHOT]: { name: 'videoshot', ...shotEntry() } as never },
        },
        _manifestKey: SHOT,
      });
    },
    sub: () =>
      ObjectRegistry.register(HistrioScene, {
        name: 'Scene',
        packageName: HISTRIO,
        // What the build resolves for a class on its parent's table, so the
        // subclass can register before its parent does.
        tableName: 'scenes',
        ...(replaceParent === undefined ? {} : { replaceParent }),
      }),
  };
  return { VideoScene, HistrioScene, VideoShot, registrations };
}

let restore: () => void;
beforeEach(() => {
  restore = snapshotObjectRegistryState();
  ObjectRegistry.clear();
});
afterEach(() => {
  // The library declarer seeds the package manifest cache.
  clearManifestCache();
  restore();
});

describe('same-named subclass of another package: manifest registration', () => {
  it.each(
    ORDERS.map((order) => [order.join(' → '), order] as const),
  )('replaceParent: false keeps base and subtype distinct (%s)', (_label, order) => {
    const steps = manifestSteps(subEntry(false));
    for (const step of order) steps[step]();
    expect(describeRegistry()).toEqual(SUBTYPE_REGISTRY);
    expect(ObjectRegistry.getDescendants(BASE)).toContain(SUB);
    // Registering everything again changes nothing.
    for (const step of order) steps[step]();
    for (const step of [...order].reverse()) steps[step]();
    expect(describeRegistry()).toEqual(SUBTYPE_REGISTRY);
  });

  describe.each([
    'app',
    'library',
  ] as const)('replaceParent: true declared by the %s package', (declarer) => {
    it.each(
      ORDERS.map((order) => [order.join(' → '), order] as const),
    )('replaces the parent and keeps its declaration (%s)', (_label, order) => {
      const steps = manifestSteps(subEntry(true), declarer);
      for (const step of order) steps[step]();
      expect(describeRegistry()).toEqual(REPLACED_REGISTRY);
      for (const step of order) steps[step]();
      for (const step of [...order].reverse()) steps[step]();
      expect(describeRegistry()).toEqual(REPLACED_REGISTRY);
    });
  });

  it.each([
    ['base → sub', ['base', 'sub']],
    ['sub → base', ['sub', 'base']],
  ] as const)('refuses a subclass that declares no choice (%s)', (_label, order) => {
    const steps = manifestSteps(subEntry(undefined));
    steps[order[0]]();
    const before = [...ObjectRegistry.getAllClasses().keys()];
    let thrown: unknown;
    try {
      steps[order[1]]();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: 'CONFIG_SAME_NAME_SUBCLASS_UNDECLARED',
      message:
        `${SUB} extends ${BASE}, a class of the same name from another package, without saying which it is. ` +
        `Add replaceParent to the @smrt() options of ${SUB}: ` +
        `replaceParent: true makes it replace ${BASE} (one model on the parent's table; the parent's qualified name and aliases resolve to it), ` +
        `replaceParent: false registers it as a subtype of ${BASE} under its own qualified name.`,
    });
    // The refused registration left the registry as it was.
    expect([...ObjectRegistry.getAllClasses().keys()]).toEqual(before);
  });

  it.each([
    ['base → sub', ['base', 'sub']],
    ['sub → base', ['sub', 'base']],
  ] as const)('refuses a subtype whose plain parent has no discriminator (%s)', (_label, order) => {
    const steps = manifestSteps(subEntry(false), 'app', false);
    steps[order[0]]();
    const before = [...ObjectRegistry.getAllClasses().keys()];
    expect(() => steps[order[1]]()).toThrow(
      expect.objectContaining({
        code: 'CONFIG_SAME_NAME_SUBTYPE_WITHOUT_DISCRIMINATOR',
        message: expect.stringMatching(
          new RegExp(
            `^${SUB} declares replaceParent: false, but its parent ${BASE} is not a single-table-inheritance model.*Declare replaceParent: true on ${SUB} to replace ${BASE}, or rename ${SUB}\\.$`,
          ),
        ),
      }),
    );
    expect([...ObjectRegistry.getAllClasses().keys()]).toEqual(before);
  });

  it.each([
    ['base → sub', ['base', 'sub']],
    ['sub → base', ['sub', 'base']],
  ] as const)('refuses a subtype of a plain parent even on a table of its own (%s)', (_label, order) => {
    const own = subEntry(false);
    own.decoratorConfig = { replaceParent: false, tableName: 'histrio_scenes' };
    const steps = manifestSteps(own, 'app', false);
    steps[order[0]]();
    expect(() => steps[order[1]]()).toThrow(
      expect.objectContaining({
        code: 'CONFIG_SAME_NAME_SUBTYPE_WITHOUT_DISCRIMINATOR',
      }),
    );
  });

  it('still fails an unqualified reference that two classes answer', () => {
    const steps = manifestSteps(subEntry(false));
    for (const step of ORDERS[0]) steps[step]();
    // A model of a third package naming `Scene` cannot mean both.
    fromManifest(
      '@fixture/other:Storyboard',
      {
        className: 'Storyboard',
        qualifiedName: '@fixture/other:Storyboard' as never,
        packageName: '@fixture/other',
        filePath: 'src/models/storyboard.ts',
        fields: {
          sceneId: { type: 'foreignKey', related: 'Scene', _meta: {} },
        },
        methods: {},
        decoratorConfig: {},
      },
      '@fixture/other',
    );
    expect(
      ObjectRegistry.resolveRelationshipTarget(
        '@fixture/other:Storyboard',
        'sceneId',
      ),
    ).toBeNull();
    expect(ObjectRegistry.getCanonicalClassName('Scene')).toBeUndefined();
  });

  it('a replacement of a subtype leaves the base to the subtype', () => {
    // base ← histrio (subtype) ← app (replaces histrio). The app class
    // reaches the base only through a subtype, so it does not replace it.
    const APP = '@fixture/app:Scene';
    const app: Fixture = {
      ...subEntry(true),
      qualifiedName: APP as never,
      packageName: '@fixture/app',
      extendsQualified: SUB,
      filePath: 'src/models/app-scene.ts',
    };
    const steps = {
      ...manifestSteps(subEntry(false)),
      app: () => fromManifest(APP, app, '@fixture/app'),
    };
    const summaries = (
      [
        ['base', 'sub', 'app'],
        ['app', 'sub', 'base'],
        ['sub', 'app', 'base'],
        ['app', 'base', 'sub'],
      ] as const
    ).map((order) => {
      ObjectRegistry.clear();
      for (const step of order) steps[step]();
      return {
        keys: [...ObjectRegistry.getAllClasses().keys()].sort(),
        base: ObjectRegistry.getClass(BASE)?.qualifiedName,
        sub: ObjectRegistry.getClass(SUB)?.qualifiedName,
        replaced: ObjectRegistry.getClass(APP)?.replacedQualifiedNames,
      };
    });
    for (const summary of summaries) {
      expect(summary).toEqual({
        keys: [APP, BASE].sort(),
        base: BASE,
        sub: APP,
        replaced: [SUB],
      });
    }
  });
});

describe('same-named subclass of another package: constructor registration', () => {
  const CTOR_SUBTYPE_REGISTRY = SUBTYPE_REGISTRY;
  const CTOR_ORDERS = [
    ['base', 'shot', 'sub'],
    ['base', 'sub', 'shot'],
    ['sub', 'base', 'shot'],
    ['sub', 'shot', 'base'],
  ] as const;

  it.each(
    CTOR_ORDERS.map((order) => [order.join(' → '), order] as const),
  )('replaceParent: false keeps base and subtype distinct (%s)', (_label, order) => {
    const fixture = constructors(false);
    for (const step of order) fixture.registrations[step]();
    expect(describeRegistry()).toEqual(CTOR_SUBTYPE_REGISTRY);
    expect(ObjectRegistry.getClass(BASE)?.constructor).toBe(fixture.VideoScene);
    expect(ObjectRegistry.getClass(SUB)?.constructor).toBe(
      fixture.HistrioScene,
    );
    expect(
      ObjectRegistry.getClassByConstructor(fixture.VideoScene)?.qualifiedName,
    ).toBe(BASE);
    for (const step of order) fixture.registrations[step]();
    expect(describeRegistry()).toEqual(CTOR_SUBTYPE_REGISTRY);
  });

  it.each(
    CTOR_ORDERS.map((order) => [order.join(' → '), order] as const),
  )('replaceParent: true replaces the parent and keeps its declaration (%s)', (_label, order) => {
    const fixture = constructors(true);
    for (const step of order) fixture.registrations[step]();
    expect(describeRegistry()).toEqual({
      ...REPLACED_REGISTRY,
      // A replacement constructor carries its parent's fields with its own.
      baseFields: expect.arrayContaining(['title', 'mood']),
    });
    expect(ObjectRegistry.getClass(BASE)?.constructor).toBe(
      fixture.HistrioScene,
    );
    expect(
      ObjectRegistry.getEffectiveClassByConstructor(fixture.VideoScene)
        ?.constructor,
    ).toBe(fixture.HistrioScene);
    for (const step of order) fixture.registrations[step]();
    expect(ObjectRegistry.getClass(BASE)?.constructor).toBe(
      fixture.HistrioScene,
    );
    expect(describeRegistry().keys).toEqual(REPLACED_REGISTRY.keys);
  });

  it.each([
    ['base → sub', ['base', 'sub']],
    ['sub → base', ['sub', 'base']],
  ] as const)('refuses a subclass that declares no choice (%s)', (_label, order) => {
    const fixture = constructors(undefined);
    fixture.registrations[order[0]]();
    expect(() => fixture.registrations[order[1]]()).toThrow(
      expect.objectContaining({
        code: 'CONFIG_SAME_NAME_SUBCLASS_UNDECLARED',
        message: expect.stringContaining(
          `${SUB} extends ${BASE}, a class of the same name from another package, without saying which it is.`,
        ),
      }),
    );
  });

  it.each([
    ['base → sub', ['base', 'sub']],
    ['sub → base', ['sub', 'base']],
  ] as const)('refuses a subtype whose plain parent has no discriminator (%s)', (_label, order) => {
    const fixture = constructors(false, false);
    fixture.registrations[order[0]]();
    expect(() => fixture.registrations[order[1]]()).toThrow(
      expect.objectContaining({
        code: 'CONFIG_SAME_NAME_SUBTYPE_WITHOUT_DISCRIMINATOR',
      }),
    );
  });

  it.each([
    ['base → sub', ['base', 'sub']],
    ['sub → base', ['sub', 'base']],
  ] as const)('refuses a subtype of a plain parent even on a table of its own (%s)', (_label, order) => {
    class PlainScene extends SmrtObject {
      title = '';
    }
    class OwnTableScene extends PlainScene {
      mood = '';
    }
    const registrations = {
      base: () =>
        ObjectRegistry.register(PlainScene, {
          name: 'Scene',
          packageName: VIDEO,
          tableName: 'scenes',
        }),
      sub: () =>
        ObjectRegistry.register(OwnTableScene, {
          name: 'Scene',
          packageName: HISTRIO,
          tableName: 'histrio_scenes',
          replaceParent: false,
        }),
    };
    registrations[order[0]]();
    expect(() => registrations[order[1]]()).toThrow(
      expect.objectContaining({
        code: 'CONFIG_SAME_NAME_SUBTYPE_WITHOUT_DISCRIMINATOR',
        message: expect.stringContaining(
          `${SUB} declares replaceParent: false, but its parent ${BASE} is not a single-table-inheritance model`,
        ),
      }),
    );
  });

  it('never inherits the choice from the class it replaces', () => {
    const fixture = constructors(true);
    for (const step of ['base', 'sub'] as const) fixture.registrations[step]();
    // The replacement inherits its parent's configuration, but a class that
    // extends the replacement under the same name must declare its own choice.
    class AppScene extends fixture.HistrioScene {}
    expect(() =>
      ObjectRegistry.register(AppScene, {
        name: 'Scene',
        packageName: '@fixture/app',
      }),
    ).toThrow(
      expect.objectContaining({ code: 'CONFIG_SAME_NAME_SUBCLASS_UNDECLARED' }),
    );
  });
});

describe('same-named subclass of another package: manifest and constructor together', () => {
  const PHASES = [
    ['manifest then constructor', 'manifest', 'constructor'],
    ['constructor then manifest', 'constructor', 'manifest'],
  ] as const;
  const PAIR_ORDERS = [
    ['base', 'shot', 'sub'],
    ['sub', 'shot', 'base'],
  ] as const;

  describe.each(PHASES)('%s', (_label, first, second) => {
    describe.each(
      PAIR_ORDERS.map((order) => [order.join(' → '), order] as const),
    )('%s', (_order, order) => {
      it.each([
        ['replaceParent: false', false, SUBTYPE_REGISTRY],
        ['replaceParent: true', true, REPLACED_REGISTRY],
      ] as const)('%s', (_choice, replaceParent, expected) => {
        const fixture = constructors(replaceParent);
        const manifests = manifestSteps(subEntry(replaceParent));
        const run = (path: 'manifest' | 'constructor') => {
          // A constructor needs its parent's constructor to exist, not to be
          // registered: both orders are exercised on both paths.
          for (const step of order) {
            if (path === 'manifest') manifests[step]();
            else fixture.registrations[step]();
          }
        };
        run(first);
        run(second);
        expect(describeRegistry()).toEqual({
          ...expected,
          baseFields: expect.arrayContaining(expected.baseFields),
        });
        const effectiveBase = replaceParent
          ? fixture.HistrioScene
          : fixture.VideoScene;
        expect(ObjectRegistry.getClass(BASE)?.constructor).toBe(effectiveBase);
        expect(ObjectRegistry.getClass(SUB)?.constructor).toBe(
          fixture.HistrioScene,
        );
      });
    });
  });
});

describe('same-named replacement registered before its parent', () => {
  /** Everything a parent-first registration derives for the effective model. */
  function effective() {
    const entry = ObjectRegistry.getClass(BASE);
    return {
      keys: [...ObjectRegistry.getAllClasses().keys()].sort(),
      qualifiedName: entry?.qualifiedName,
      tenant: ObjectRegistry.getTenantScopedConfig(BASE),
      entryTenant: entry?.tenantScopedConfig,
      validators: entry?.validators?.length ?? 0,
      validationRules: (entry?.validationRules ?? []).map(
        (rule) => (rule as { field?: string }).field,
      ),
      sensitive: ObjectRegistry.getConfig(BASE).sensitive === true,
      collection: entry?.collection,
      table: ObjectRegistry.getTableName(BASE),
      fields: [...(entry?.fields.keys() ?? [])].sort(),
      replaced: entry?.replacedQualifiedNames,
    };
  }

  function pair(childTable?: string) {
    class VideoScene extends SmrtObject {
      tenantId = '';
      title = '';
    }
    class HistrioScene extends VideoScene {
      mood = '';
    }
    field({ type: 'text', required: true })(VideoScene.prototype, 'title');
    field({ type: 'text' })(HistrioScene.prototype, 'mood');
    return {
      VideoScene,
      HistrioScene,
      base: () =>
        ObjectRegistry.register(VideoScene, {
          name: 'Scene',
          packageName: VIDEO,
          tableName: 'video_scenes',
          tableStrategy: 'sti',
          sensitive: true,
          tenantScoped: { mode: 'required' },
          previousQualifiedNames: [OLD],
        }),
      sub: () =>
        ObjectRegistry.register(HistrioScene, {
          name: 'Scene',
          packageName: HISTRIO,
          replaceParent: true,
          ...(childTable ? { tableName: childTable } : {}),
        }),
    };
  }

  it('derives the same model in either order: tenancy, validators, sensitivity, collection and the parent table', () => {
    const results = (['base-first', 'sub-first'] as const).map((order) => {
      ObjectRegistry.clear();
      const fixture = pair();
      if (order === 'base-first') {
        fixture.base();
        fixture.sub();
      } else {
        fixture.sub();
        fixture.base();
      }
      expect(ObjectRegistry.getClass(BASE)?.constructor).toBe(
        fixture.HistrioScene,
      );
      return effective();
    });
    expect(results[1]).toEqual(results[0]);
    expect(results[0]).toMatchObject({
      keys: [SUB],
      qualifiedName: SUB,
      tenant: expect.objectContaining({ mode: 'required' }),
      sensitive: true,
      table: 'video_scenes',
      replaced: [BASE],
    });
    expect(results[0].validators).toBeGreaterThan(0);
  });

  it('binds a decorated replacement that names no table to its custom-table parent, in either order', () => {
    const tables = (['base-first', 'sub-first'] as const).map((order) => {
      ObjectRegistry.clear();
      const fixture = pair();
      const decorate = () =>
        smrt({ name: 'Scene', packageName: HISTRIO, replaceParent: true })(
          fixture.HistrioScene,
        );
      if (order === 'base-first') {
        fixture.base();
        decorate();
      } else {
        decorate();
        fixture.base();
      }
      return {
        table: ObjectRegistry.getTableName(BASE),
        replaced:
          ObjectRegistry.getClass(BASE)?.constructor === fixture.HistrioScene,
      };
    });
    expect(tables[1]).toEqual(tables[0]);
    expect(tables[0]).toEqual({ table: 'video_scenes', replaced: true });
  });

  it('refuses, in either order, a replacement that names a table of its own', () => {
    for (const order of ['base-first', 'sub-first'] as const) {
      ObjectRegistry.clear();
      const fixture = pair('histrio_scenes');
      const steps =
        order === 'base-first'
          ? [fixture.base, fixture.sub]
          : [fixture.sub, fixture.base];
      steps[0]();
      expect(() => steps[1]()).toThrow(
        expect.objectContaining({
          code: 'CONFIG_SAME_NAME_REPLACEMENT_TABLE_MISMATCH',
        }),
      );
    }
  });

  it('refuses a late parent whose alias another model already claims, leaving the registry as it was', () => {
    const OTHER = '@fixture/other:Clip';
    class Clip extends SmrtObject {}
    // Constructor path: replacement constructor first, then its parent.
    ObjectRegistry.register(Clip, {
      packageName: '@fixture/other',
      tableName: 'clips',
      previousQualifiedNames: [OLD],
    });
    const fixture = pair();
    fixture.sub();
    const before = [...ObjectRegistry.getAllClasses().keys()].sort();
    expect(() => fixture.base()).toThrow(
      expect.objectContaining({
        code: 'CONFIG_QUALIFIED_NAME_ALIAS_COLLISION',
      }),
    );
    expect([...ObjectRegistry.getAllClasses().keys()].sort()).toEqual(before);
    expect(ObjectRegistry.getClassByQualifiedName(OLD)?.qualifiedName).toBe(
      OTHER,
    );
    expect(ObjectRegistry.getClass(SUB)?.constructor).toBe(
      fixture.HistrioScene,
    );

    // Manifest path: the replacing entry first, then the parent's entry.
    ObjectRegistry.clear();
    ObjectRegistry.register(Clip, {
      packageName: '@fixture/other',
      tableName: 'clips',
      previousQualifiedNames: [OLD],
    });
    fromManifest(SUB, subEntry(true), HISTRIO);
    const manifestBefore = [...ObjectRegistry.getAllClasses().keys()].sort();
    expect(() => fromManifest(BASE, baseEntry(), VIDEO)).toThrow(
      expect.objectContaining({
        code: 'CONFIG_QUALIFIED_NAME_ALIAS_COLLISION',
      }),
    );
    expect([...ObjectRegistry.getAllClasses().keys()].sort()).toEqual(
      manifestBefore,
    );
    expect(ObjectRegistry.getClassByQualifiedName(OLD)?.qualifiedName).toBe(
      OTHER,
    );
  });
});

describe('three same-named levels through constructors', () => {
  const APP = '@fixture/app:Scene';
  function chain() {
    class VideoScene extends SmrtObject {
      title = '';
    }
    class HistrioScene extends VideoScene {
      mood = '';
    }
    class AppScene extends HistrioScene {
      badge = '';
    }
    class VideoShot extends SmrtObject {
      sceneId = '';
    }
    return {
      VideoScene,
      HistrioScene,
      AppScene,
      steps: {
        base: () =>
          ObjectRegistry.register(VideoScene, {
            name: 'Scene',
            packageName: VIDEO,
            tableName: 'scenes',
            tableStrategy: 'sti',
            previousQualifiedNames: [OLD],
          }),
        middle: () =>
          ObjectRegistry.register(HistrioScene, {
            name: 'Scene',
            packageName: HISTRIO,
            tableName: 'scenes',
            replaceParent: false,
          }),
        leaf: () =>
          ObjectRegistry.register(AppScene, {
            name: 'Scene',
            packageName: '@fixture/app',
            tableName: 'scenes',
            replaceParent: true,
          }),
        shot: () =>
          ObjectRegistry.register(VideoShot, {
            name: 'VideoShot',
            packageName: VIDEO,
            _manifest: {
              version: '1',
              timestamp: 0,
              packageName: VIDEO,
              objects: {
                [SHOT]: { name: 'videoshot', ...shotEntry() } as never,
              },
            },
            _manifestKey: SHOT,
          }),
      },
    };
  }
  const PERMUTATIONS = [
    ['base', 'middle', 'leaf'],
    ['base', 'leaf', 'middle'],
    ['middle', 'base', 'leaf'],
    ['middle', 'leaf', 'base'],
    ['leaf', 'base', 'middle'],
    ['leaf', 'middle', 'base'],
  ] as const;

  it.each(
    PERMUTATIONS.map((order) => [order.join(' → '), order] as const),
  )('the leaf replaces only the middle subtype; the base keeps its key, alias and foreign key (%s)', (_label, order) => {
    const fixture = chain();
    // An STI subclass whose direct same-named parent is not registered yet
    // is refused (the existing STI parent rule) when its family is known
    // to be STI; it registers once the intermediate has.
    const refused: string[] = [];
    for (const step of order) {
      try {
        fixture.steps[step]();
      } catch (error) {
        expect(String((error as Error).message)).toMatch(
          /unregistered direct parent/,
        );
        refused.push(step);
      }
    }
    for (const step of refused) fixture.steps[step]();
    // Every order converges in one pass: a leaf whose same-named middle has
    // not registered waits for it.
    expect(refused).toEqual([]);
    fixture.steps.shot();
    expect({
      keys: [...ObjectRegistry.getAllClasses().keys()].sort(),
      base: ObjectRegistry.getClass(BASE)?.qualifiedName,
      baseCtor: ObjectRegistry.getClass(BASE)?.constructor,
      middle: ObjectRegistry.getClass(SUB)?.qualifiedName,
      leafReplaced: ObjectRegistry.getClass(APP)?.replacedQualifiedNames,
      alias: ObjectRegistry.getClassByQualifiedName(OLD)?.qualifiedName,
      foreignKey: ObjectRegistry.resolveRelationshipTarget(SHOT, 'sceneId'),
    }).toEqual({
      keys: [APP, BASE, SHOT].sort(),
      base: BASE,
      baseCtor: fixture.VideoScene,
      middle: APP,
      leafReplaced: [SUB],
      alias: BASE,
      foreignKey: BASE,
    });
  });
});

describe('same-named run-time model', () => {
  it('keeps its own replaces option: without it the model coexists and the run-time manifest still projects', () => {
    const fixture = constructors(false);
    fixture.registrations.base();
    registerRuntimeModel({
      name: 'Scene',
      packageName: '@fixture/runtime-app',
      extends: BASE,
      fields: { nickname: { type: 'text' } },
    });
    expect(ObjectRegistry.getClass(BASE)?.constructor).toBe(fixture.VideoScene);
    expect(
      ObjectRegistry.getClass('@fixture/runtime-app:Scene')?.qualifiedName,
    ).toBe('@fixture/runtime-app:Scene');
    // The REST ETag projection reads the registry as a manifest; a run-time
    // model that declares no replaceParent is not a build error there.
    expect(() => computeRuntimeWebManifestHash()).not.toThrow();
  });

  it('survives the parent registering again, from its manifest or its constructor', () => {
    fromManifest(BASE, baseEntry(), VIDEO);
    registerRuntimeModel({
      name: 'Scene',
      packageName: '@fixture/runtime-app',
      extends: BASE,
      fields: { nickname: { type: 'text' } },
    });
    expect(() => fromManifest(BASE, baseEntry(), VIDEO)).not.toThrow();
    expect([...ObjectRegistry.getAllClasses().keys()].sort()).toEqual(
      [BASE, '@fixture/runtime-app:Scene'].sort(),
    );

    ObjectRegistry.clear();
    const fixture = constructors(false);
    fixture.registrations.base();
    registerRuntimeModel({
      name: 'Scene',
      packageName: '@fixture/runtime-app',
      extends: BASE,
      fields: { nickname: { type: 'text' } },
    });
    expect(() => fixture.registrations.base()).not.toThrow();
    expect(ObjectRegistry.getClass(BASE)?.constructor).toBe(fixture.VideoScene);
    expect(
      ObjectRegistry.getClass('@fixture/runtime-app:Scene')?.qualifiedName,
    ).toBe('@fixture/runtime-app:Scene');
  });
});

describe('same-named subtype: rows', () => {
  it('hydrates base and subtype rows as their own class, and a foreign key to the base as the base', async () => {
    const fixture = constructors(false);
    for (const step of ['base', 'shot', 'sub'] as const)
      fixture.registrations[step]();
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      includeSystemTables: false,
      classes: [BASE, SUB, SHOT],
    });
    try {
      const scenes = await ObjectRegistry.getCollection(BASE, { db });
      const histrioScenes = await ObjectRegistry.getCollection(SUB, { db });
      const shots = await ObjectRegistry.getCollection(SHOT, { db });
      const plain = await scenes.create({ title: 'Town hall' });
      await plain.save();
      const staged = await histrioScenes.create({
        title: 'Stage',
        mood: 'tense',
      });
      await staged.save();

      expect(
        (await db.query('SELECT title, _meta_type FROM scenes ORDER BY title'))
          .rows,
      ).toEqual([
        { title: 'Stage', _meta_type: SUB },
        { title: 'Town hall', _meta_type: BASE },
      ]);
      // The base collection is the family's root and returns each row as
      // the class that wrote it.
      const all = await scenes.list({ orderBy: 'title ASC' });
      expect(all.map((row) => row.constructor)).toEqual([
        fixture.HistrioScene,
        fixture.VideoScene,
      ]);
      // The subtype collection sees only its own rows.
      const own = await histrioScenes.list({});
      expect(own).toHaveLength(1);
      expect(own[0]).toBeInstanceOf(fixture.HistrioScene);
      expect((own[0] as unknown as { mood: string }).mood).toBe('tense');
      // A base lookup of a subtype row returns the subtype.
      expect(await scenes.get(String(staged.id))).toBeInstanceOf(
        fixture.HistrioScene,
      );
      expect(await histrioScenes.get(String(plain.id))).toBeNull();

      const shot = await shots.create({ sceneId: String(plain.id) });
      await shot.save();
      const related = await (
        shot as unknown as { loadRelated(field: string): Promise<SmrtObject> }
      ).loadRelated('sceneId');
      expect(related.constructor).toBe(fixture.VideoScene);
    } finally {
      await db.close?.();
    }
  });

  it('hydrates rows as the replacement under either qualified name', async () => {
    const fixture = constructors(true);
    for (const step of ['base', 'shot', 'sub'] as const)
      fixture.registrations[step]();
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      includeSystemTables: false,
      classes: [SUB, SHOT],
    });
    try {
      const byBase = await ObjectRegistry.getCollection(BASE, { db });
      const scene = await byBase.create({ title: 'One model', mood: 'calm' });
      await scene.save();
      expect(scene).toBeInstanceOf(fixture.HistrioScene);
      const bySub = await ObjectRegistry.getCollection(SUB, { db });
      expect(await bySub.get(String(scene.id))).toBeInstanceOf(
        fixture.HistrioScene,
      );
      expect((await db.query('SELECT _meta_type FROM scenes')).rows).toEqual([
        { _meta_type: SUB },
      ]);
    } finally {
      await db.close?.();
    }
  });
});
