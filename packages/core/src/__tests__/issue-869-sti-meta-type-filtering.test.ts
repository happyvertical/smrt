/**
 * Issue #869: STI filtering by _meta_type fails - field not in manifest
 *
 * When using STI (Single Table Inheritance), filtering by `_meta_type`
 * should work for both base class and child class collections.
 *
 * @see https://github.com/happyvertical/smrt/issues/869
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import type { Meta } from '../decorators/index.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';

// ─────────────────────────────────────────────────────────────────────────────
// Test Classes
// ─────────────────────────────────────────────────────────────────────────────

@smrt({ tableStrategy: 'sti' })
class Issue869Tenant extends SmrtObject {
  name: string = '';
  status: string = 'active';
}

@smrt()
class Issue869Publication extends Issue869Tenant {
  timezone: Meta<string> = 'America/Edmonton';
  editorialEmail: Meta<string> = '';
}

@smrt()
class Issue869Workspace extends Issue869Tenant {
  domain: Meta<string> = '';
}

class Issue869TenantCollection extends SmrtCollection<Issue869Tenant> {
  static readonly _itemClass = Issue869Tenant;
}

class Issue869PublicationCollection extends SmrtCollection<Issue869Publication> {
  static readonly _itemClass = Issue869Publication;
}

class Issue869WorkspaceCollection extends SmrtCollection<Issue869Workspace> {
  static readonly _itemClass = Issue869Workspace;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('Issue #869: STI _meta_type filtering', () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'smrt-issue-869-test-'));
    dbPath = join(tempDir, 'issue-869.json');

    // Register collections
    ObjectRegistry.registerCollection(
      'Issue869Tenant',
      Issue869TenantCollection,
    );
    ObjectRegistry.registerCollection(
      'Issue869Publication',
      Issue869PublicationCollection,
    );
    ObjectRegistry.registerCollection(
      'Issue869Workspace',
      Issue869WorkspaceCollection,
    );
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should correctly identify STI strategy for child classes', () => {
    // Verify that child classes inherit STI strategy
    expect(ObjectRegistry.getTableStrategy('Issue869Tenant')).toBe('sti');
    expect(ObjectRegistry.getTableStrategy('Issue869Publication')).toBe('sti');
    expect(ObjectRegistry.getTableStrategy('Issue869Workspace')).toBe('sti');
  });

  it('should not throw WHERE validation error for STI child class fields (issue #869)', async () => {
    // Issue #869: When manifest is not available (e.g., inline test classes),
    // the WHERE clause validation should not block queries.
    // This test verifies that filtering by _meta_type and parent fields
    // doesn't throw "Invalid WHERE clause field" errors at the validation stage.

    // Create collection
    const publicationCollection = await Issue869PublicationCollection.create({
      db: { type: 'json', url: dbPath },
    });

    // Access the private convertWhereKeys method to test validation directly
    // This avoids database schema issues in tests
    const convertWhereKeys = (
      publicationCollection as any
    ).convertWhereKeys.bind(publicationCollection);

    // Test 1: _meta_type should be valid for STI child class
    expect(() => convertWhereKeys({ _meta_type: 'SomeType' })).not.toThrow();

    // Test 2: Parent class field 'status' should be valid (no manifest = skip validation)
    expect(() => convertWhereKeys({ status: 'active' })).not.toThrow();

    // Test 3: Combined filter should be valid
    expect(() =>
      convertWhereKeys({ _meta_type: 'SomeType', status: 'active' }),
    ).not.toThrow();

    // Test 4: 'in' operator with _meta_type
    expect(() =>
      convertWhereKeys({ '_meta_type in': ['Type1', 'Type2'] }),
    ).not.toThrow();

    // Test 5: Parent field 'name' should also be valid
    expect(() => convertWhereKeys({ name: 'Test' })).not.toThrow();
  });

  it('should validate WHERE clause fields for all STI child collections', async () => {
    // Test that all STI collections (base, Publication, Workspace) can validate
    // _meta_type and parent class fields without throwing errors.

    // Create all collections
    const tenantCollection = await Issue869TenantCollection.create({
      db: { type: 'json', url: dbPath },
    });
    const publicationCollection = await Issue869PublicationCollection.create({
      db: { type: 'json', url: dbPath },
    });
    const workspaceCollection = await Issue869WorkspaceCollection.create({
      db: { type: 'json', url: dbPath },
    });

    // Access convertWhereKeys for each collection
    const tenantConvert = (tenantCollection as any).convertWhereKeys.bind(
      tenantCollection,
    );
    const pubConvert = (publicationCollection as any).convertWhereKeys.bind(
      publicationCollection,
    );
    const wsConvert = (workspaceCollection as any).convertWhereKeys.bind(
      workspaceCollection,
    );

    // Test base collection - should allow _meta_type and its own fields
    expect(() =>
      tenantConvert({
        _meta_type: 'Publication',
        name: 'Test',
        status: 'active',
      }),
    ).not.toThrow();

    // Test Publication collection - should allow parent fields (name, status)
    expect(() =>
      pubConvert({
        _meta_type: 'Publication',
        name: 'Local News',
        status: 'active',
      }),
    ).not.toThrow();

    // Test Workspace collection - should allow parent fields (name, status)
    expect(() =>
      wsConvert({
        _meta_type: 'Workspace',
        name: 'Development',
        status: 'active',
      }),
    ).not.toThrow();

    // Test 'in' operator on _meta_type for child collections
    expect(() =>
      pubConvert({ '_meta_type in': ['Pub1', 'Pub2'] }),
    ).not.toThrow();

    expect(() => wsConvert({ '_meta_type in': ['Ws1', 'Ws2'] })).not.toThrow();
  });
});
