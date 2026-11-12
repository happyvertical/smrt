/**
 * #4921: an app class that replaces a smrt class by simple name is used by
 * smrt's own collections too (create / get / list), and rows written through
 * either collection carry the replacing class's qualified discriminator.
 *
 * The core test manifest scans all fixtures as ONE package and keeps one
 * entry per class name, so column and `required` behaviour of the app class's
 * own added fields is deliberately not asserted here.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectRegistry } from '../index.js';
import { snapshotObjectRegistryState } from '../test-utils.js';
import { getTestDatabase } from '../testing/database.js';
import {
  Account4921 as SmrtAccount,
  SmrtAccountCollection4921,
  Own4921 as SmrtOwn,
  SmrtOwnCollection4921,
  Shared4921 as SmrtShared,
  SmrtSharedCollection4921,
  SmrtUntouchedCollection4921,
  Untouched4921,
} from './issue-4921-smrt.fixture.js';

type AppModule = typeof import('./issue-4921-app.fixture.js');

interface AppShape {
  loyaltyTier?: string;
  appOnly?: () => string;
  _meta_type?: string;
}

describe('#4921 same-name app subclass is used by smrt collections', () => {
  let restoreRegistry: () => void;
  let app: AppModule;
  let db: DatabaseInterface;

  beforeAll(async () => {
    restoreRegistry = snapshotObjectRegistryState();
    // Loaded after the smrt fixture so the app class replaces smrt's entry.
    app = await import('./issue-4921-app.fixture.js');
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
  });

  afterAll(() => {
    restoreRegistry();
  });

  async function metaTypes(table: string): Promise<string[]> {
    const result = (await db.query(
      `SELECT _meta_type FROM "${table}" ORDER BY name`,
    )) as unknown as
      | { rows?: Array<Record<string, unknown>> }
      | Array<Record<string, unknown>>;
    const rows = Array.isArray(result) ? result : (result.rows ?? []);
    return rows.map((r) => String(r._meta_type));
  }

  it('replaces the smrt entry in the registry', () => {
    expect(ObjectRegistry.getClassByConstructor(SmrtShared as never)).toBe(
      undefined,
    );
    expect(ObjectRegistry.getClass('Shared4921')?.constructor).toBe(
      app.Shared4921,
    );
  });

  describe.each([
    {
      label: 'shared-table parent',
      Collection: () => SmrtSharedCollection4921,
      AppCollection: () => app.AppSharedCollection4921,
      Smrt: () => SmrtShared,
      App: () => app.Shared4921,
    },
    {
      label: 'own-table parent',
      Collection: () => SmrtOwnCollection4921,
      AppCollection: () => app.AppOwnCollection4921,
      Smrt: () => SmrtOwn,
      App: () => app.Own4921,
    },
  ])('$label', ({ Collection, AppCollection, Smrt, App }) => {
    it('create() returns the app class with its defaults and methods', async () => {
      const collection = await Collection().create({ db });
      const instance = await collection.create({ name: 'created' } as never);
      expect(instance.constructor).toBe(App());
      expect(instance).toBeInstanceOf(Smrt());
      const shape = instance as unknown as AppShape;
      expect(shape.loyaltyTier).toBe('bronze');
      expect(shape.appOnly?.()).toBe('app method ran');
      await instance.save();
    });

    it('get() and list() return the app class', async () => {
      const collection = await Collection().create({ db });
      const instance = await collection.create({ name: 'readable' } as never);
      await instance.save();

      const fetched = await collection.get({ id: instance.id });
      expect(fetched?.constructor).toBe(App());
      expect((fetched as unknown as AppShape).appOnly?.()).toBe(
        'app method ran',
      );

      const listed = await collection.list({});
      expect(listed.length).toBeGreaterThan(0);
      for (const item of listed) {
        expect(item.constructor).toBe(App());
      }
    });

    it("smrt's and the app's collection agree on the objects", async () => {
      const smrtCollection = await Collection().create({ db });
      const appCollection = await AppCollection().create({ db });
      const viaApp = await appCollection.create({ name: 'via app' } as never);
      await viaApp.save();
      const viaSmrt = await smrtCollection.create({
        name: 'via smrt',
      } as never);
      await viaSmrt.save();
      const seen = await smrtCollection.list({});
      expect(seen.some((i) => i.id === viaApp.id)).toBe(true);
      expect(seen.some((i) => i.id === viaSmrt.id)).toBe(true);
      expect(viaApp.constructor).toBe(viaSmrt.constructor);
    });
  });

  it('writes the same qualified _meta_type through either collection (shared table)', async () => {
    const smrtCollection = await SmrtSharedCollection4921.create({ db });
    const appCollection = await app.AppSharedCollection4921.create({ db });
    const viaSmrt = await smrtCollection.create({
      name: 'zz-meta-smrt',
    } as never);
    await viaSmrt.save();
    const viaApp = await appCollection.create({ name: 'zz-meta-app' } as never);
    await viaApp.save();

    const qualified = '@local/app-fixture4921:Shared4921';
    expect((viaSmrt as unknown as AppShape)._meta_type).toBe(qualified);
    expect((viaApp as unknown as AppShape)._meta_type).toBe(qualified);

    const table = ObjectRegistry.getTableName(qualified);
    const stored = await metaTypes(String(table));
    expect(stored.length).toBeGreaterThan(0);
    expect(new Set(stored)).toEqual(new Set([qualified]));
  });

  describe('effective-class lookup', () => {
    it('resolves the replaced smrt constructor to the app entry', () => {
      const entry = ObjectRegistry.getEffectiveClassByConstructor(
        SmrtShared as never,
      );
      expect(entry?.constructor).toBe(app.Shared4921);
      expect(entry?.qualifiedName).toBe('@local/app-fixture4921:Shared4921');
    });

    it('returns a live entry unchanged', () => {
      const entry = ObjectRegistry.getEffectiveClassByConstructor(
        app.Shared4921 as never,
      );
      expect(entry?.constructor).toBe(app.Shared4921);
    });
  });

  describe('not substituted', () => {
    it('a subclass with a different name is a new kind', async () => {
      expect(
        ObjectRegistry.getClassByConstructor(app.VipOwn4921 as never)
          ?.qualifiedName,
      ).toBe('@local/app-fixture4921:VipOwn4921');
      const collection = await SmrtOwnCollection4921.create({ db });
      const instance = await collection.create({ name: 'plain' } as never);
      expect(instance.constructor).toBe(app.Own4921);
      expect(instance.constructor).not.toBe(app.VipOwn4921);
      expect(
        ObjectRegistry.getEffectiveClassByConstructor(SmrtOwn as never)
          ?.constructor,
      ).toBe(app.Own4921);
    });

    it('an unrelated same-named class from another package coexists', async () => {
      expect(
        ObjectRegistry.getClassByConstructor(SmrtAccount as never)
          ?.qualifiedName,
      ).toBe('@happyvertical/smrt-fixture4921:Account4921');
      expect(
        ObjectRegistry.getEffectiveClassByConstructor(SmrtAccount as never)
          ?.constructor,
      ).toBe(SmrtAccount);
      expect(
        ObjectRegistry.getClassByConstructor(app.Account4921 as never)
          ?.qualifiedName,
      ).toBe('@local/app-fixture4921:Account4921');

      const collection = await SmrtAccountCollection4921.create({ db });
      const instance = await collection.create({ name: 'acct' } as never);
      expect(instance.constructor).toBe(SmrtAccount);
    });

    it('a class that was never replaced behaves as before', async () => {
      expect(
        ObjectRegistry.getEffectiveClassByConstructor(Untouched4921 as never)
          ?.constructor,
      ).toBe(Untouched4921);
      const collection = await SmrtUntouchedCollection4921.create({ db });
      const instance = await collection.create({ name: 'plain' } as never);
      expect(instance.constructor).toBe(Untouched4921);
      await instance.save();
      const listed = await collection.list({});
      expect(listed.every((i) => i.constructor === Untouched4921)).toBe(true);
    });

    it('returns undefined for a constructor that was never registered', () => {
      class Stranger {}
      expect(
        ObjectRegistry.getEffectiveClassByConstructor(Stranger as never),
      ).toBeUndefined();
    });
  });
});
