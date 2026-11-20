/**
 * #5143: a class that extends a class of the same simple name from another
 * package replaces that parent only by declaring `replaceParent: true` in its
 * own `@smrt()` options. Declaring nothing is refused, and so is
 * `replaceParent: false` (a same-named subclass registered next to its
 * parent). Nothing else decides: not which package is the app, not which
 * registered first, not whether the class arrived as a manifest entry or a
 * constructor.
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
import { getManifestCache } from '../../manifest/store';
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

const COEXISTENCE_UNSUPPORTED = expect.objectContaining({
  code: 'CONFIG_SAME_NAME_COEXISTENCE_UNSUPPORTED',
  message: expect.stringContaining(
    `${SUB} declares replaceParent: false, but a same-named subclass cannot be registered next to its parent`,
  ),
});

/** What a refused registration must leave exactly as it was. */
function registrySnapshot() {
  return {
    keys: [...ObjectRegistry.getAllClasses().keys()].sort(),
    base: ObjectRegistry.getClass(BASE)?.qualifiedName ?? null,
    baseCtor: ObjectRegistry.getClass(BASE)?.constructor ?? null,
    sub: ObjectRegistry.getClass(SUB)?.qualifiedName ?? null,
    aliases: [...ObjectRegistry.getQualifiedNameAliases()],
  };
}

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
  describe.each([
    'app',
    'library',
  ] as const)('replaceParent: false declared by the %s package', (declarer) => {
    // A library's self-registration also seeds its manifest for STI sibling
    // loading, so once refused, later registrations of the same table family
    // keep failing closed with the same error; its refusal is checked with
    // the subclass arriving last.
    it.each(
      ORDERS.filter(
        (order) => declarer === 'app' || order.at(-1) === 'sub',
      ).map((order) => [order.join(' → '), order] as const),
    )('is refused whatever arrives first, leaving the registry as it was (%s)', (_label, order) => {
      const steps = manifestSteps(subEntry(false), declarer);
      for (const step of order) {
        if (step !== 'sub') {
          steps[step]();
          continue;
        }
        const before = registrySnapshot();
        expect(() => steps.sub()).toThrow(COEXISTENCE_UNSUPPORTED);
        expect(registrySnapshot()).toEqual(before);
      }
      expect(registrySnapshot()).toMatchObject({
        keys: [BASE, SHOT].sort(),
        base: BASE,
        sub: null,
        aliases: [[OLD, BASE]],
      });
      // The parent registers again unchanged once the refused entry is gone.
      steps.base();
      expect(ObjectRegistry.getClass(BASE)?.qualifiedName).toBe(BASE);
    });
  });

  describe('a package manifest with a refused entry after a valid one', () => {
    const CLIP = `${HISTRIO}:Clip`;
    const packageWith = (sub: Fixture): SmartObjectManifest => ({
      version: '1',
      timestamp: 0,
      packageName: HISTRIO,
      objects: {
        [CLIP]: {
          name: 'clip',
          collection: 'clips',
          className: 'Clip',
          qualifiedName: CLIP as never,
          packageName: HISTRIO,
          filePath: 'src/models/clip.ts',
          fields: { title: { type: 'text', _meta: {} } },
          methods: {},
          decoratorConfig: {},
        } as SmartObjectDefinition,
        [SUB]: {
          name: 'scene',
          collection: 'scenes',
          ...sub,
        } as SmartObjectDefinition,
      },
    });

    it.each([
      ['replaceParent: false', false, COEXISTENCE_UNSUPPORTED],
      [
        'no declared choice',
        undefined,
        expect.objectContaining({
          code: 'CONFIG_SAME_NAME_SUBCLASS_UNDECLARED',
        }),
      ],
    ] as const)('registers none of it and caches nothing (%s)', (_label, choice, refusal) => {
      fromManifest(BASE, baseEntry(), VIDEO);
      const before = registrySnapshot();
      expect(() =>
        ObjectRegistry.registerPackageManifest(packageWith(subEntry(choice))),
      ).toThrow(refusal);
      expect(registrySnapshot()).toEqual(before);
      expect(ObjectRegistry.getClass(CLIP)).toBeUndefined();
      expect(getManifestCache().has(HISTRIO)).toBe(false);
      // The corrected package then registers whole.
      ObjectRegistry.registerPackageManifest(packageWith(subEntry(true)));
      expect(ObjectRegistry.getClass(CLIP)?.qualifiedName).toBe(CLIP);
      expect(ObjectRegistry.getClass(BASE)?.qualifiedName).toBe(SUB);
    });
  });

  it('refuses replaceParent: false next to a parent kept only as the declaration a replacement took over', () => {
    const APP = '@fixture/app:Scene';
    const app: Fixture = {
      ...subEntry(true),
      qualifiedName: APP as never,
      packageName: '@fixture/app',
      filePath: 'src/models/app-scene.ts',
    };
    // The replacement arrives first; the parent's entry is then retained as
    // the declaration it replaced (retain-as-replaced).
    fromManifest(APP, app, '@fixture/app');
    fromManifest(BASE, baseEntry(), VIDEO);
    expect(ObjectRegistry.getClass(BASE)?.qualifiedName).toBe(APP);
    const before = registrySnapshot();
    expect(() => fromManifest(SUB, subEntry(false), HISTRIO)).toThrow(
      COEXISTENCE_UNSUPPORTED,
    );
    expect(registrySnapshot()).toEqual(before);
    expect(ObjectRegistry.getClass(APP)?.replacedQualifiedNames).toEqual([
      BASE,
    ]);
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
        `${SUB} extends ${BASE}, a class of the same name from another package, without declaring replaceParent. ` +
        `Add replaceParent: true to the @smrt() options of ${SUB} to make it replace ${BASE} ` +
        `(one model on the parent's table; the parent's qualified name and aliases resolve to it), ` +
        `or give ${SUB} a different class name to keep it a separate model.`,
    });
    // The refused registration left the registry as it was.
    expect([...ObjectRegistry.getAllClasses().keys()]).toEqual(before);
  });
});

describe('same-named subclass of another package: constructor registration', () => {
  // A same-named subclass registers after its parent; the other order is
  // refused (see `registered before its parent`).
  const CTOR_ORDERS = [
    ['base', 'shot', 'sub'],
    ['base', 'sub', 'shot'],
    ['shot', 'base', 'sub'],
  ] as const;

  it.each(
    [...CTOR_ORDERS, ['sub', 'base', 'shot'] as const].map(
      (order) => [order.join(' → '), order] as const,
    ),
  )('refuses replaceParent: false before or after its parent, leaving the registry as it was (%s)', (_label, order) => {
    const fixture = constructors(false);
    for (const step of order) {
      if (step !== 'sub') {
        fixture.registrations[step]();
        continue;
      }
      const before = registrySnapshot();
      expect(() => fixture.registrations.sub()).toThrow(
        COEXISTENCE_UNSUPPORTED,
      );
      expect(registrySnapshot()).toEqual(before);
    }
    expect(
      ObjectRegistry.getClassByConstructor(fixture.HistrioScene),
    ).toBeUndefined();
    expect(ObjectRegistry.getClass(BASE)?.constructor).toBe(fixture.VideoScene);
  });

  it('refuses replaceParent: false through the decorator, before and after its parent', () => {
    const early = constructors(false);
    expect(() =>
      smrt({ name: 'Scene', packageName: HISTRIO, replaceParent: false })(
        early.HistrioScene,
      ),
    ).toThrow(COEXISTENCE_UNSUPPORTED);
    expect([...ObjectRegistry.getAllClasses().keys()]).toEqual([]);
    const fixture = constructors(false);
    fixture.registrations.base();
    const before = registrySnapshot();
    expect(() =>
      smrt({ name: 'Scene', packageName: HISTRIO, replaceParent: false })(
        fixture.HistrioScene,
      ),
    ).toThrow(COEXISTENCE_UNSUPPORTED);
    expect(registrySnapshot()).toEqual(before);
  });

  it('refuses a re-registration that turns a replacement into replaceParent: false, keeping the replacement', () => {
    const fixture = constructors(true);
    fixture.registrations.base();
    fixture.registrations.sub();
    const before = registrySnapshot();
    expect(before.base).toBe(SUB);
    expect(() =>
      ObjectRegistry.register(fixture.HistrioScene, {
        name: 'Scene',
        packageName: HISTRIO,
        tableName: 'scenes',
        replaceParent: false,
      }),
    ).toThrow(COEXISTENCE_UNSUPPORTED);
    expect(registrySnapshot()).toEqual(before);
    expect(ObjectRegistry.getClass(SUB)?.config.replaceParent).toBe(true);
  });

  it('refuses a re-registration that moves a replacement off its parent table, keeping the shared table', () => {
    const fixture = constructors(true);
    fixture.registrations.base();
    fixture.registrations.sub();
    const before = registrySnapshot();
    expect(() =>
      ObjectRegistry.register(fixture.HistrioScene, {
        name: 'Scene',
        packageName: HISTRIO,
        tableName: 'histrio_scenes',
        replaceParent: true,
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'CONFIG_SAME_NAME_REPLACEMENT_TABLE_MISMATCH',
      }),
    );
    expect(registrySnapshot()).toEqual(before);
    expect(ObjectRegistry.getClass(BASE)?.schema?.tableName).toBe('scenes');
    expect(ObjectRegistry.getClass(SUB)?.schema?.tableName).toBe('scenes');
    // The same table, restated, is still an ordinary re-registration.
    fixture.registrations.sub();
    expect(registrySnapshot()).toEqual(before);
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
  ] as const)('refuses a subclass that declares no choice (%s)', (_label, order) => {
    const fixture = constructors(undefined);
    fixture.registrations[order[0]]();
    expect(() => fixture.registrations[order[1]]()).toThrow(
      expect.objectContaining({
        code: 'CONFIG_SAME_NAME_SUBCLASS_UNDECLARED',
        message: expect.stringContaining(
          `${SUB} extends ${BASE}, a class of the same name from another package, without declaring replaceParent.`,
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
  // Constructors always register parent first (a same-named subclass before
  // its parent is refused); the manifest phase takes both orders.
  const CTOR_ORDER = ['base', 'shot', 'sub'] as const;

  describe.each(PHASES)('%s', (_label, first, second) => {
    describe.each(
      PAIR_ORDERS.map((order) => [order.join(' → '), order] as const),
    )('%s', (_order, order) => {
      it.each([
        ['replaceParent: true', true, REPLACED_REGISTRY],
      ] as const)('%s', (_choice, replaceParent, expected) => {
        const fixture = constructors(replaceParent);
        const manifests = manifestSteps(subEntry(replaceParent));
        const run = (path: 'manifest' | 'constructor') => {
          // Manifest entries arrive in either order; a constructor after
          // its parent.
          for (const step of path === 'manifest' ? order : CTOR_ORDER) {
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
        expect(ObjectRegistry.getClass(BASE)?.constructor).toBe(
          fixture.HistrioScene,
        );
        expect(ObjectRegistry.getClass(SUB)?.constructor).toBe(
          fixture.HistrioScene,
        );
      });
    });
  });
});

describe('same-named subclass registered before its parent', () => {
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

  it('fails closed, leaving nothing registered, and the parent-first order derives tenancy, validators, sensitivity and the parent table', () => {
    const early = pair();
    const Child = class Scene extends early.VideoScene {};
    expect(() =>
      ObjectRegistry.register(Child, {
        name: 'Scene',
        packageName: HISTRIO,
        replaceParent: true,
      }),
    ).toThrow(
      expect.objectContaining({
        code: 'CONFIG_SAME_NAME_PARENT_UNREGISTERED',
        message: expect.stringContaining(
          `${SUB} declares replaceParent, but the same-named class it extends`,
        ),
      }),
    );
    expect(ObjectRegistry.getClassByConstructor(Child)).toBeUndefined();
    expect([...ObjectRegistry.getAllClasses().keys()]).toEqual([]);
    const results = [0, 1].map(() => {
      ObjectRegistry.clear();
      const fixture = pair();
      fixture.base();
      fixture.sub();
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

  it('binds a decorated replacement that names no table to its custom-table parent, and refuses the decorator before the parent', () => {
    const early = pair();
    expect(() =>
      smrt({ name: 'Scene', packageName: HISTRIO, replaceParent: true })(
        early.HistrioScene,
      ),
    ).toThrow(
      expect.objectContaining({ code: 'CONFIG_SAME_NAME_PARENT_UNREGISTERED' }),
    );
    ObjectRegistry.clear();
    const fixture = pair();
    fixture.base();
    smrt({ name: 'Scene', packageName: HISTRIO, replaceParent: true })(
      fixture.HistrioScene,
    );
    expect({
      table: ObjectRegistry.getTableName(BASE),
      replaced:
        ObjectRegistry.getClass(BASE)?.constructor === fixture.HistrioScene,
    }).toEqual({ table: 'video_scenes', replaced: true });
  });

  it('refuses a replacement that names a table of its own', () => {
    const fixture = pair('histrio_scenes');
    fixture.base();
    expect(() => fixture.sub()).toThrow(
      expect.objectContaining({
        code: 'CONFIG_SAME_NAME_REPLACEMENT_TABLE_MISMATCH',
      }),
    );
  });

  it('refuses a late parent declaration whose alias another model already claims, leaving the registry as it was', () => {
    const OTHER = '@fixture/other:Clip';
    class Clip extends SmrtObject {}
    // Manifest path: the replacing entry first, then the parent's entry. (A
    // replacement constructor cannot register before its parent.)
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
            replaceParent: true,
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
  )('the leaf replaces the middle replacement and, through it, the base: key, alias and foreign key follow it (%s)', (_label, order) => {
    const fixture = chain();
    // A same-named class registered before the class it extends fails closed:
    // the middle or leaf before anything (CONFIG_SAME_NAME_PARENT_UNREGISTERED),
    // the leaf after the base but before the middle (the existing STI rule,
    // CONFIG_STI_UNREGISTERED_PARENT). Nothing waits; the refused class is
    // registered again once its parent has.
    const refused: Array<[string, string]> = [];
    for (const step of order) {
      try {
        fixture.steps[step]();
      } catch (error) {
        refused.push([step, (error as { code?: string }).code ?? '']);
      }
    }
    const expectedRefusals: Record<string, Array<[string, string]>> = {
      'base,middle,leaf': [],
      'base,leaf,middle': [['leaf', 'CONFIG_STI_UNREGISTERED_PARENT']],
      'middle,base,leaf': [
        ['middle', 'CONFIG_SAME_NAME_PARENT_UNREGISTERED'],
        ['leaf', 'CONFIG_STI_UNREGISTERED_PARENT'],
      ],
      'middle,leaf,base': [
        ['middle', 'CONFIG_SAME_NAME_PARENT_UNREGISTERED'],
        ['leaf', 'CONFIG_SAME_NAME_PARENT_UNREGISTERED'],
      ],
      'leaf,base,middle': [['leaf', 'CONFIG_SAME_NAME_PARENT_UNREGISTERED']],
      'leaf,middle,base': [
        ['leaf', 'CONFIG_SAME_NAME_PARENT_UNREGISTERED'],
        ['middle', 'CONFIG_SAME_NAME_PARENT_UNREGISTERED'],
      ],
    };
    expect(refused).toEqual(expectedRefusals[order.join()]);
    for (const step of ['base', 'middle', 'leaf'] as const)
      if (refused.some(([name]) => name === step)) fixture.steps[step]();
    fixture.steps.shot();
    expect({
      keys: [...ObjectRegistry.getAllClasses().keys()].sort(),
      base: ObjectRegistry.getClass(BASE)?.qualifiedName,
      baseCtor: ObjectRegistry.getClass(BASE)?.constructor,
      middle: ObjectRegistry.getClass(SUB)?.qualifiedName,
      leafReplaced: [
        ...(ObjectRegistry.getClass(APP)?.replacedQualifiedNames ?? []),
      ].sort(),
      alias: ObjectRegistry.getClassByQualifiedName(OLD)?.qualifiedName,
      foreignKey: ObjectRegistry.resolveRelationshipTarget(SHOT, 'sceneId'),
    }).toEqual({
      keys: [APP, SHOT].sort(),
      base: APP,
      baseCtor: fixture.AppScene,
      middle: APP,
      leafReplaced: [BASE, SUB].sort(),
      alias: APP,
      foreignKey: APP,
    });
  });
});

describe('same-named run-time model', () => {
  it('keeps its own replaces option: without it the model coexists and the run-time manifest still projects', () => {
    const fixture = constructors(true);
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
    const fixture = constructors(true);
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

describe('same-named replacement: rows', () => {
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
