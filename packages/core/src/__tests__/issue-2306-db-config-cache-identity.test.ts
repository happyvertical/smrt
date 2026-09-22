/**
 * Test for issue #2306: stable collection-cache identity for database
 * config objects.
 * https://github.com/happyvertical/smrt/issues/2306
 *
 * Follow-up to PR #2305 review: `ObjectRegistry.getCollection()` keyed
 * initialized `DatabaseInterface` values by object identity and string URLs
 * by value, but plain `DatabaseConfig` objects also fell into the identity
 * path — semantically equivalent fresh config objects missed the collection
 * cache and churned the LRU / repeated initialization.
 *
 * These tests pin the three-way contract:
 * - equivalent config objects share one cached collection;
 * - `:memory:` databases and live adapter instances stay isolated;
 * - auth tokens change the key without ever appearing in it.
 *
 * PR #2922 review follow-ups pinned here as well:
 * - alternate in-memory spellings (`memory`, `file::memory:`) isolate;
 * - pre-created `client` handles key by reference, never merge;
 * - URL-embedded credentials are digested, never embedded.
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { resolveCollectionDbCacheKey } from '../registry/db-cache-key';

// Test class defined at top level for the AST scanner
@smrt({ api: true, mcp: true, cli: true })
class DbIdentityTestObject extends SmrtObject {
  name: string = '';
}

class DbIdentityTestCollection extends SmrtCollection<DbIdentityTestObject> {
  static readonly _itemClass = DbIdentityTestObject;
}

describe('Issue #2306: collection-cache identity for db config objects', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(
      path.join(os.tmpdir(), `smrt-issue-2306-${randomUUID().slice(0, 8)}-`),
    );
    ObjectRegistry.clear();
    ObjectRegistry.register(DbIdentityTestObject, {
      api: true,
      mcp: true,
      cli: true,
    });
  });

  afterEach(() => {
    ObjectRegistry.clear();
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('equivalent config objects share the cached collection', () => {
    it('returns the same instance for fresh equivalent { type, url } objects', async () => {
      const first = await ObjectRegistry.getCollection<DbIdentityTestObject>(
        'DbIdentityTestObject',
        { db: { type: 'sqlite', url: path.join(tempDir, 'shared.db') } },
      );
      const second = await ObjectRegistry.getCollection<DbIdentityTestObject>(
        'DbIdentityTestObject',
        { db: { type: 'sqlite', url: path.join(tempDir, 'shared.db') } },
      );

      expect(second).toBe(first);
    });

    it('is insensitive to property order', async () => {
      const first = await ObjectRegistry.getCollection<DbIdentityTestObject>(
        'DbIdentityTestObject',
        {
          db: {
            url: path.join(tempDir, 'ordered.db'),
            type: 'sqlite' as const,
          },
        },
      );
      const second = await ObjectRegistry.getCollection<DbIdentityTestObject>(
        'DbIdentityTestObject',
        {
          db: {
            type: 'sqlite' as const,
            url: path.join(tempDir, 'ordered.db'),
          },
        },
      );

      expect(second).toBe(first);
    });

    it('is insensitive to nested options property order', async () => {
      const first = await ObjectRegistry.getCollection<DbIdentityTestObject>(
        'DbIdentityTestObject',
        {
          db: {
            type: 'sqlite' as const,
            url: path.join(tempDir, 'nested.db'),
            options: { busyTimeout: 5000, foreignKeys: true },
          },
        },
      );
      const second = await ObjectRegistry.getCollection<DbIdentityTestObject>(
        'DbIdentityTestObject',
        {
          db: {
            options: { foreignKeys: true, busyTimeout: 5000 },
            url: path.join(tempDir, 'nested.db'),
            type: 'sqlite' as const,
          },
        },
      );

      expect(second).toBe(first);
    });

    it('keeps a file URL and its plain path distinct from other urls', async () => {
      const first = await ObjectRegistry.getCollection<DbIdentityTestObject>(
        'DbIdentityTestObject',
        { db: { type: 'sqlite', url: path.join(tempDir, 'a.db') } },
      );
      const second = await ObjectRegistry.getCollection<DbIdentityTestObject>(
        'DbIdentityTestObject',
        { db: { type: 'sqlite', url: path.join(tempDir, 'b.db') } },
      );

      expect(second).not.toBe(first);
    });
  });

  describe(':memory: databases stay isolated per call site', () => {
    it('does not share a cached collection between equivalent :memory: configs', async () => {
      const first = await ObjectRegistry.getCollection<DbIdentityTestObject>(
        'DbIdentityTestObject',
        { db: { type: 'sqlite', url: ':memory:' } },
      );
      const second = await ObjectRegistry.getCollection<DbIdentityTestObject>(
        'DbIdentityTestObject',
        { db: { type: 'sqlite', url: ':memory:' } },
      );

      expect(second).not.toBe(first);
    });

    it('isolates url-less sqlite configs (implicit :memory:)', async () => {
      const first = await ObjectRegistry.getCollection<DbIdentityTestObject>(
        'DbIdentityTestObject',
        { db: { type: 'sqlite' } },
      );
      const second = await ObjectRegistry.getCollection<DbIdentityTestObject>(
        'DbIdentityTestObject',
        { db: { type: 'sqlite' } },
      );

      expect(second).not.toBe(first);
    });
  });

  describe('live adapter instances keep identity isolation', () => {
    it('keys initialized DatabaseInterface values by instance, not value', async () => {
      // Distinct URLs so the SQL SDK's own pool cache cannot hand back the
      // same instance twice — this test is about the registry's identity
      // key, and equal-value distinct instances are what it must separate.
      const dbA = await getDatabase({
        type: 'sqlite',
        url: path.join(tempDir, 'instances-a.db'),
      });
      const dbB = await getDatabase({
        type: 'sqlite',
        url: path.join(tempDir, 'instances-b.db'),
      });

      try {
        const viaA = await ObjectRegistry.getCollection<DbIdentityTestObject>(
          'DbIdentityTestObject',
          { db: dbA },
        );
        const viaB = await ObjectRegistry.getCollection<DbIdentityTestObject>(
          'DbIdentityTestObject',
          { db: dbB },
        );
        const viaAAgain =
          await ObjectRegistry.getCollection<DbIdentityTestObject>(
            'DbIdentityTestObject',
            { db: dbA },
          );

        expect(viaB).not.toBe(viaA);
        expect(viaAAgain).toBe(viaA);
      } finally {
        await dbA.close();
        await dbB.close();
      }
    });
  });

  describe('auth tokens change the key without appearing in it', () => {
    it('derives different cache keys for different auth tokens', () => {
      const base = {
        type: 'postgres' as const,
        url: 'postgres://localhost/app',
      };
      const keyA = resolveCollectionDbCacheKey({
        ...base,
        authToken: 'token-alpha',
      });
      const keyB = resolveCollectionDbCacheKey({
        ...base,
        authToken: 'token-beta',
      });
      const keyNoToken = resolveCollectionDbCacheKey({ ...base });

      expect(keyA).toBeDefined();
      expect(keyB).toBeDefined();
      expect(keyNoToken).toBeDefined();
      expect(keyA).not.toBe(keyB);
      expect(keyA).not.toBe(keyNoToken);
      expect(keyB).not.toBe(keyNoToken);
    });

    it('never embeds the token (or a reversible form) in the key', () => {
      const key = resolveCollectionDbCacheKey({
        type: 'postgres',
        url: 'postgres://localhost/app',
        authToken: 'secretprefix-secret-suffix',
      });

      expect(key).toBeDefined();
      expect(key).not.toContain('secretprefix-secret-suffix');
      expect(key).not.toContain('secretprefix');
      expect(key).not.toContain('secret-suffix');
    });

    it('is stable across fresh equivalent config objects with tokens', () => {
      const keyA = resolveCollectionDbCacheKey({
        type: 'postgres',
        url: 'postgres://localhost/app',
        authToken: 'token-alpha',
      });
      const keyB = resolveCollectionDbCacheKey({
        authToken: 'token-alpha',
        url: 'postgres://localhost/app',
        type: 'postgres',
      });

      expect(keyA).toBe(keyB);
    });
  });

  describe('PostgreSQL runtime timeouts stay in the key (#2377 alignment)', () => {
    it('derives different keys for configs differing only in timeouts', () => {
      const keyDefault = resolveCollectionDbCacheKey({
        type: 'postgres',
        url: 'postgres://localhost/app',
      });
      const keyLong = resolveCollectionDbCacheKey({
        type: 'postgres',
        url: 'postgres://localhost/app',
        timeouts: { statementTimeout: '60s' },
      });

      expect(keyDefault).toBeDefined();
      expect(keyLong).toBeDefined();
      expect(keyLong).not.toBe(keyDefault);
    });
  });

  describe('opaque values do not split equivalent configs', () => {
    it('treats two references to the same function as equivalent', () => {
      const logger = () => undefined;
      const keyA = resolveCollectionDbCacheKey({
        type: 'sqlite',
        url: path.join(tempDir, 'opaque.db'),
        logger,
      });
      const keyB = resolveCollectionDbCacheKey({
        logger,
        url: path.join(tempDir, 'opaque.db'),
        type: 'sqlite',
      });

      expect(keyA).toBe(keyB);
    });

    it('treats distinct functions as different', () => {
      const keyA = resolveCollectionDbCacheKey({
        type: 'sqlite',
        url: path.join(tempDir, 'opaque.db'),
        logger: () => undefined,
      });
      const keyB = resolveCollectionDbCacheKey({
        type: 'sqlite',
        url: path.join(tempDir, 'opaque.db'),
        logger: () => undefined,
      });

      expect(keyA).not.toBe(keyB);
    });
  });

  describe('string urls keep value keys', () => {
    it('returns the same cached collection for equal strings', async () => {
      const dbString = `file:${path.join(tempDir, 'string.db')}`;
      const first = await ObjectRegistry.getCollection<DbIdentityTestObject>(
        'DbIdentityTestObject',
        { db: dbString },
      );
      const second = await ObjectRegistry.getCollection<DbIdentityTestObject>(
        'DbIdentityTestObject',
        { db: dbString },
      );

      expect(second).toBe(first);
    });
  });

  describe('alternate in-memory spellings stay isolated (PR #2922 review)', () => {
    // Key-level assertions only: resolving these spellings through
    // getCollection would hand the sqlite adapter a literal filename and
    // create a real file in the working directory. What matters here is
    // that the cache key takes the per-call-site `instance:` branch (as
    // `class.ts` and the table verifier assume) instead of a shared value
    // key — the getCollection-level isolation pattern is already pinned by
    // the `:memory:` tests above.
    it("keys 'memory' configs by instance, never by value", () => {
      const keyA = resolveCollectionDbCacheKey({
        type: 'sqlite',
        url: 'memory',
      });
      const keyB = resolveCollectionDbCacheKey({
        url: 'memory',
        type: 'sqlite',
      });

      expect(keyA).toMatch(/^instance:\d+$/);
      expect(keyB).toMatch(/^instance:\d+$/);
      expect(keyA).not.toBe(keyB);
    });

    it("keys 'file::memory:' configs by instance, never by value", () => {
      const keyA = resolveCollectionDbCacheKey({
        type: 'sqlite',
        url: 'file::memory:',
      });
      const keyB = resolveCollectionDbCacheKey({
        url: 'file::memory:',
        type: 'sqlite',
      });

      expect(keyA).toMatch(/^instance:\d+$/);
      expect(keyB).toMatch(/^instance:\d+$/);
      expect(keyA).not.toBe(keyB);
    });
  });

  describe('pre-created client handles keep reference identity (PR #2922 review)', () => {
    // A minimal stand-in for a pg Pool: API on the prototype, no own
    // enumerable keys — exactly the shape that flattened to `{}`.
    class FakePool {
      async query() {
        return { rows: [] };
      }
    }

    const dbUrl = 'postgres://localhost/app';

    it('never merges configs holding distinct client instances', () => {
      const keyA = resolveCollectionDbCacheKey({
        type: 'postgres',
        url: dbUrl,
        client: new FakePool(),
      });
      const keyB = resolveCollectionDbCacheKey({
        type: 'postgres',
        url: dbUrl,
        client: new FakePool(),
      });

      expect(keyA).toBeDefined();
      expect(keyB).toBeDefined();
      expect(keyA).not.toBe(keyB);
    });

    it('shares the key when the same client instance is reused', () => {
      const client = new FakePool();
      const keyA = resolveCollectionDbCacheKey({
        type: 'postgres',
        url: dbUrl,
        client,
      });
      const keyB = resolveCollectionDbCacheKey({
        client,
        url: dbUrl,
        type: 'postgres',
      });

      expect(keyA).toBe(keyB);
    });

    it('never merges configs holding distinct non-enumerable client handles', () => {
      const withHiddenClient = () =>
        Object.defineProperty({ type: 'postgres', url: dbUrl }, 'client', {
          value: new FakePool(),
          enumerable: false,
        });

      const keyA = resolveCollectionDbCacheKey(withHiddenClient());
      const keyB = resolveCollectionDbCacheKey(withHiddenClient());

      expect(keyA).toBeDefined();
      expect(keyA).not.toBe(keyB);
    });
  });

  describe('URL-embedded credentials never reach the key (PR #2922 review)', () => {
    it('derives different keys for different URL passwords', () => {
      const keyA = resolveCollectionDbCacheKey({
        type: 'postgres',
        url: 'postgres://app:secret-one@localhost/app',
      });
      const keyB = resolveCollectionDbCacheKey({
        type: 'postgres',
        url: 'postgres://app:secret-two@localhost/app',
      });

      expect(keyA).toBeDefined();
      expect(keyB).toBeDefined();
      expect(keyA).not.toBe(keyB);
    });

    it('never embeds the URL password (or fragments) in the key', () => {
      const key = resolveCollectionDbCacheKey({
        type: 'postgres',
        url: 'postgres://appuser:s3cr3t-pw-fragment@localhost/app',
      });

      expect(key).toBeDefined();
      expect(key).not.toContain('s3cr3t-pw-fragment');
      expect(key).not.toContain('s3cr3t');
      expect(key).not.toContain('pw-fragment');
      expect(key).not.toContain('appuser:s3cr3t');
    });

    it('is stable across fresh equivalent configs with URL credentials', () => {
      const keyA = resolveCollectionDbCacheKey({
        type: 'postgres',
        url: 'postgres://app:***@localhost/app',
      });
      const keyB = resolveCollectionDbCacheKey({
        url: 'postgres://app:***@localhost/app',
        type: 'postgres',
      });

      expect(keyA).toBe(keyB);
    });

    it('never embeds credentials from a bare string db URL', () => {
      const key = resolveCollectionDbCacheKey(
        'postgres://appuser:***@localhost/app',
      );

      expect(key).toBeDefined();
      expect(key).not.toContain('str0ng-pw');
      expect(key).not.toContain('appuser:str0ng-pw');
    });

    it('never embeds credentials in other string options', () => {
      const key = resolveCollectionDbCacheKey({
        type: 'postgres',
        url: 'postgres://localhost/app',
        connectionString:
          'postgres://reporting:***@localhost/app?sslmode=require',
      });

      expect(key).toBeDefined();
      expect(key).not.toContain('r3porting-pw');
      expect(key).not.toContain('reporting:r3porting-pw');
    });
  });
});
