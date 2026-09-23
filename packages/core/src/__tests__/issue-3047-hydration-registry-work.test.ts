/**
 * smrt#3047: hydrating a SmrtObject must not redo per-class registry work per
 * instance.
 *
 * Reported profile (anytown, ~9,800 hydrated rows per permission resolution):
 * every instance re-imported the manifest loader, re-ran manifest discovery
 * and reconciliation in `ensureManifestLoaded()`, and resolved its class by a
 * linear scan of every registered class. These guards pin the fix:
 *
 * - manifest discovery runs once per class per registry generation, not once
 *   per hydrated row;
 * - simple-name lookups are indexed, not O(registered classes) per call;
 * - both memos are invalidated by registry changes.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { SmrtObject, smrt } from '../index.js';
import { getRegistryGeneration } from '../registry/generation.js';
import { getClasses } from '../registry/shared-state.js';
import type { RegisteredClass } from '../registry/types.js';
import { ObjectRegistry } from '../registry.js';
import { getTestDatabase } from '../testing/database.js';

const discovery = vi.hoisted(() => ({ calls: 0 }));

vi.mock('../manifest/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../manifest/index.js')>();
  return {
    ...actual,
    discoverManifestEntry: (
      ...args: Parameters<typeof actual.discoverManifestEntry>
    ) => {
      discovery.calls++;
      return actual.discoverManifestEntry(...args);
    },
  };
});

@smrt({ idType: 'text' })
class Issue3047Widget extends SmrtObject {
  label: string = '';
  weight: number = 0;
}

class Issue3047WidgetCollection extends SmrtCollection<Issue3047Widget> {
  static readonly _itemClass = Issue3047Widget;
}

const ROWS = 1_000;

describe('smrt#3047: per-class registry work is not repeated per instance', () => {
  let db: DatabaseInterface;
  let widgets: Issue3047WidgetCollection;

  beforeEach(async () => {
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['Issue3047Widget'],
    });
    widgets = await Issue3047WidgetCollection.create({ db });
  });

  afterEach(async () => {
    await db.close?.();
  });

  it('hydrating many rows reconciles the manifest once, not per row', async () => {
    for (let index = 0; index < ROWS; index++) {
      await db.query(
        `INSERT INTO ${widgets.tableName} (id, slug, context, label, weight) VALUES (?, ?, '', ?, ?)`,
        `w-${index}`,
        `w-${index}`,
        `Widget ${index}`,
        index,
      );
    }

    // Warm: first touch may legitimately discover and reconcile.
    await widgets.list({ limit: 1 });

    discovery.calls = 0;
    const generation = getRegistryGeneration();
    const rows = await widgets.list({});

    expect(rows).toHaveLength(ROWS);
    expect(rows[ROWS - 1]?.label).toBe(`Widget ${ROWS - 1}`);
    // Pre-#3047: one discovery per hydrated row (>= ROWS).
    expect(discovery.calls).toBeLessThanOrEqual(2);
    // Steady-state hydration must not churn the registry.
    expect(getRegistryGeneration()).toBe(generation);
  });

  it('a registry change re-runs reconciliation on the next hydration', async () => {
    await widgets.create({ label: 'one', weight: 1 });
    await widgets.list({});
    discovery.calls = 0;
    await widgets.list({});
    const steady = discovery.calls;

    ObjectRegistry.invalidateInheritanceCache('Issue3047Widget');
    await widgets.list({});
    expect(discovery.calls).toBeGreaterThan(steady);
  });
});

describe('smrt#3047: simple-name lookups are indexed', () => {
  const FILLERS = 3_000;
  const fillerKeys: string[] = [];

  function fakeRegistration(name: string): RegisteredClass {
    return {
      name,
      fields: new Map(),
      methods: new Map(),
    } as unknown as RegisteredClass;
  }

  beforeEach(() => {
    const classes = getClasses();
    for (let index = 0; index < FILLERS; index++) {
      const key = `@issue-3047/fillers:Filler${index}`;
      classes.set(key, fakeRegistration(`Filler${index}`));
      fillerKeys.push(key);
    }
  });

  afterEach(() => {
    const classes = getClasses();
    for (const key of fillerKeys.splice(0)) {
      classes.delete(key);
    }
    classes.delete('@issue-3047/late:Issue3047Late');
  });

  it('resolves simple names without scanning every registered class', () => {
    const lookups = 40_000;
    const started = performance.now();
    for (let index = 0; index < lookups; index++) {
      expect(ObjectRegistry.findClass('issue3047widget')?.name).toBe(
        'Issue3047Widget',
      );
    }
    const elapsed = performance.now() - started;
    // Pre-#3047: 40,000 x 3,000+ lowercase comparisons (seconds). Indexed,
    // this is a few ms; the budget leaves wide headroom for slow runners.
    expect(elapsed).toBeLessThan(600);
    expect(ObjectRegistry.findClassesByName('FILLER17')).toHaveLength(1);
    expect(ObjectRegistry.hasClass('filler2999')).toBe(true);
  });

  it('sees registrations and removals made after the index was built', () => {
    expect(ObjectRegistry.findClass('Issue3047Late')).toBeUndefined();

    const classes = getClasses();
    classes.set(
      '@issue-3047/late:Issue3047Late',
      fakeRegistration('Issue3047Late'),
    );
    expect(ObjectRegistry.findClass('issue3047late')?.name).toBe(
      'Issue3047Late',
    );
    expect(ObjectRegistry.hasClass('ISSUE3047LATE')).toBe(true);

    classes.delete('@issue-3047/late:Issue3047Late');
    expect(ObjectRegistry.findClass('Issue3047Late')).toBeUndefined();
    expect(ObjectRegistry.findClassesByName('Issue3047Late')).toHaveLength(0);
  });
});
