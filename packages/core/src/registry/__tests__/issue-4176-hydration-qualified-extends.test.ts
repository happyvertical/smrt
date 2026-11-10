/**
 * #4176: `ensureManifestLoaded()` must not replace a class's import-qualified
 * parent with the manifest's bare `extends`.
 *
 * `Agreement` is declared by two packages. A consumer subclass registers with
 * its qualified parent (from `extendsQualified`, #4145). Lazy hydration — the
 * first `getAllFields()` on a collection — used to compare and copy only the
 * bare `extends`, so it always "hydrated" and rewrote the parent to the
 * ambiguous `Agreement`; every later inheritance walk then threw
 * `CONFIG_AMBIGUOUS_CLASS`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ObjectRegistry } from '../../registry';
import type { SmartObjectDefinition } from '../../scanner/types';
import { snapshotObjectRegistryState } from '../../test-utils';

const COMMERCE = '@test4176/commerce';
const SALES = '@test4176/sales';
const APP = '@test4176/app';
const CONSUMER = `${APP}:AdvertisingProductContract`;

const discovered = vi.hoisted(() => ({
  entries: new Map<string, Record<string, unknown>>(),
}));

vi.mock('../../manifest/manifest-loader.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../manifest/manifest-loader.js')>();
  return {
    ...actual,
    discoverManifestEntry: (
      ...args: Parameters<typeof actual.discoverManifestEntry>
    ) => {
      const fixture = discovered.entries.get(args[1]);
      return fixture
        ? Promise.resolve(fixture)
        : actual.discoverManifestEntry(...args);
    },
  };
});

function definition(
  packageName: string,
  className: string,
  extra: Partial<SmartObjectDefinition> = {},
): SmartObjectDefinition {
  return {
    name: className.toLowerCase(),
    className,
    packageName,
    collection: 'contracts4176',
    filePath: `/${packageName}/src/${className}.ts`,
    fields: { title: { type: 'text' } },
    methods: {},
    decoratorConfig: { tableStrategy: 'sti', tableName: 'contracts4176' },
    ...extra,
  } as SmartObjectDefinition;
}

function register(def: SmartObjectDefinition): void {
  ObjectRegistry.registerFromManifest(
    `${def.packageName}:${def.className}`,
    def,
    def.packageName,
  );
}

function registerParentsAndConsumer(): void {
  register(definition(COMMERCE, 'Agreement'));
  register(
    definition(SALES, 'Agreement', {
      collection: 'agreements4176',
      decoratorConfig: { tableName: 'agreements4176' },
    }),
  );
  register(
    definition(APP, 'AdvertisingProductContract', {
      extends: 'Agreement',
      extendsQualified: `${COMMERCE}:Agreement`,
    }),
  );
}

/** The consumer's manifest entry as lazy discovery returns it, with a field
 * the registration lacks so hydration actually runs. */
function discoverConsumer(extra: Partial<SmartObjectDefinition>): void {
  discovered.entries.set(
    CONSUMER,
    definition(APP, 'AdvertisingProductContract', {
      fields: { title: { type: 'text' }, placement: { type: 'text' } },
      ...extra,
    }) as unknown as Record<string, unknown>,
  );
}

describe('#4176 manifest hydration keeps the qualified parent', () => {
  let restore: () => void;

  beforeEach(() => {
    restore = snapshotObjectRegistryState();
    discovered.entries.clear();
  });

  afterEach(() => {
    discovered.entries.clear();
    restore();
  });

  const cases = {
    'a manifest with extendsQualified': {
      extends: 'Agreement',
      extendsQualified: `${COMMERCE}:Agreement`,
    },
    'a manifest that predates extendsQualified': { extends: 'Agreement' },
  } satisfies Record<string, Partial<SmartObjectDefinition>>;

  for (const [label, parent] of Object.entries(cases)) {
    it(`hydrates fields without making the parent ambiguous (${label})`, async () => {
      registerParentsAndConsumer();
      discoverConsumer(parent);

      await ObjectRegistry.ensureManifestLoaded(CONSUMER);

      const registered = ObjectRegistry.getClass(CONSUMER);
      expect(registered?.fields.has('placement')).toBe(true);
      expect(registered?.extends).toBe(`${COMMERCE}:Agreement`);
      expect(ObjectRegistry.getInheritanceChain(CONSUMER)).toEqual([
        `${COMMERCE}:Agreement`,
        CONSUMER,
      ]);
      expect(ObjectRegistry.getSTIBase(CONSUMER)).toBe(`${COMMERCE}:Agreement`);
    });
  }

  it('is reconciled once the qualified parent matches', async () => {
    registerParentsAndConsumer();
    discoverConsumer({
      fields: { title: { type: 'text' } },
      extends: 'Agreement',
      extendsQualified: `${COMMERCE}:Agreement`,
    });
    const before = ObjectRegistry.getClass(CONSUMER);

    await ObjectRegistry.ensureManifestLoaded(CONSUMER);

    // Nothing differed, so the registration was left untouched rather than
    // re-hydrated on every call.
    expect(ObjectRegistry.getClass(CONSUMER)).toBe(before);
    expect(before?.extends).toBe(`${COMMERCE}:Agreement`);
  });

  it('still adopts a qualified parent the registration lacks', async () => {
    register(definition(COMMERCE, 'Agreement'));
    register(
      definition(SALES, 'Agreement', {
        collection: 'agreements4176',
        decoratorConfig: { tableName: 'agreements4176' },
      }),
    );
    register(definition(APP, 'AdvertisingProductContract'));
    discoverConsumer({
      extends: 'Agreement',
      extendsQualified: `${SALES}:Agreement`,
    });

    await ObjectRegistry.ensureManifestLoaded(CONSUMER);

    expect(ObjectRegistry.getClass(CONSUMER)?.extends).toBe(
      `${SALES}:Agreement`,
    );
  });
});
