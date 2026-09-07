/**
 * Regression test for #2750 (ask 1).
 *
 * `getTestDatabase()` defaults `classes` to
 * `ObjectRegistry.getQualifiedClassNames()` when the caller leaves it
 * implicit. When the registry is empty at call time — most often because
 * registration happened in a different process/module instance than the one
 * the test is running in (the root cause diagnosed in #2750) — the helper
 * used to return a database with only `_smrt_*` system tables and say
 * nothing, so the resulting `no such table: <model>` failures surfaced far
 * from the actual cause.
 *
 * `getTestDatabase()` now records a `warn`-severity registry diagnostic
 * (never throws by default) whenever `classes` was left implicit and the
 * registry is empty. An explicit empty `classes: []` array is a deliberate
 * choice and stays silent.
 *
 * @see https://github.com/happyvertical/smrt/issues/2750
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearRegistryDiagnostics,
  getRegistryDiagnostics,
} from '../registry/diagnostics.js';
import { ObjectRegistry } from '../registry.js';
import { snapshotObjectRegistryState } from '../test-utils.js';
import { getTestDatabase } from '../testing/database.js';

describe('issue #2750: getTestDatabase() warns on an empty implicit registry', () => {
  let restoreRegistry: () => void;

  beforeEach(() => {
    restoreRegistry = snapshotObjectRegistryState();
    ObjectRegistry.clear();
    clearRegistryDiagnostics();
  });

  afterEach(() => {
    restoreRegistry();
    clearRegistryDiagnostics();
  });

  it('records a warn diagnostic and still returns a usable (system-tables-only) database when classes is implicit and the registry is empty', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    try {
      const diagnostics = getRegistryDiagnostics();
      const match = diagnostics.find(
        (d) => d.code === 'TEST_DATABASE_EMPTY_IMPLICIT_REGISTRY',
      );

      expect(match).toBeDefined();
      expect(match?.severity).toBe('warn');

      // Never throws by default — the db is still returned, with system
      // tables only.
      const result = await db.query(
        `SELECT name FROM sqlite_master WHERE type='table'`,
      );
      const rows = Array.isArray(result)
        ? result
        : (result as { rows: Array<{ name: string }> }).rows;
      const tableNames = rows.map((row) => row.name);
      expect(tableNames.some((name) => name.startsWith('_smrt_'))).toBe(true);
    } finally {
      await db.close?.();
    }
  });

  it('does not warn when the caller explicitly passes an empty classes list', async () => {
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: [],
    });
    try {
      const diagnostics = getRegistryDiagnostics();
      const match = diagnostics.find(
        (d) => d.code === 'TEST_DATABASE_EMPTY_IMPLICIT_REGISTRY',
      );
      expect(match).toBeUndefined();
    } finally {
      await db.close?.();
    }
  });

  it('does not warn when the registry has registered classes', async () => {
    ObjectRegistry.registerFromManifest(
      '@happyvertical/smrt-issue-2750-fixture:Widget',
      {
        name: 'widget',
        className: 'Widget',
        qualifiedName: '@happyvertical/smrt-issue-2750-fixture:Widget',
        collection: 'widgets',
        filePath: 'packages/fixture/src/Widget.ts',
        packageName: '@happyvertical/smrt-issue-2750-fixture',
        fields: { label: { type: 'text', required: false } },
        methods: {},
        decoratorConfig: {},
        exportName: 'Widget',
        collectionExportName: 'WidgetCollection',
        // biome-ignore lint/suspicious/noExplicitAny: minimal manifest fixture
      } as any,
      '@happyvertical/smrt-issue-2750-fixture',
    );

    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    try {
      const diagnostics = getRegistryDiagnostics();
      const match = diagnostics.find(
        (d) => d.code === 'TEST_DATABASE_EMPTY_IMPLICIT_REGISTRY',
      );
      expect(match).toBeUndefined();
    } finally {
      await db.close?.();
    }
  });
});
