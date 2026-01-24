/**
 * Test for Issue #809: tenantScoped decorator auto-population
 *
 * Verifies that using @smrt({ tenantScoped: true }) in core
 * automatically populates tenantId from context during save/create.
 *
 * @see https://github.com/happyvertical/smrt/issues/809
 */

import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { generateSchema } from '@happyvertical/smrt-core/schema/utils';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withTenant } from '../context.js';
import { disableTenancy, enableTenancy } from '../interceptor.js';

// Test class using @smrt({ tenantScoped: true })
@smrt({ tenantScoped: true })
class Build extends SmrtObject {
  contractId: string = '';
  status: string = '';
}

class BuildCollection extends SmrtCollection<Build> {
  static readonly _itemClass = Build;
}

describe('Issue #809: Auto-populate tenantId on create', () => {
  let db: DatabaseInterface;
  let dbPath: string;
  let collection: BuildCollection;

  beforeEach(async () => {
    // Enable tenant enforcement
    enableTenancy();

    // Create test database
    dbPath = join(tmpdir(), `test-tenant-${randomUUID().slice(0, 8)}.db`);
    db = await getDatabase({ type: 'sqlite', url: dbPath });

    // Create schema for Build class
    const schema = await generateSchema(Build);
    await db.syncSchema(schema);

    // Create collection
    collection = await BuildCollection.create({
      db,
    });
  });

  afterEach(async () => {
    disableTenancy();
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  it('should auto-populate tenantId from context on collection.create()', async () => {
    const tenantId = 'test-tenant-123';

    await withTenant({ tenantId }, async () => {
      // Create without manually providing tenantId
      const build = await collection.create({
        contractId: 'contract-abc',
        status: 'pending',
        // NO tenantId here! Should be auto-populated
      });

      // Verify tenantId was auto-populated
      expect(build.tenantId).toBe(tenantId);

      // Verify it was saved to database
      const loaded = await collection.get({ id: build.id });
      expect(loaded?.tenantId).toBe(tenantId);
    });
  });

  it('should auto-populate tenantId on manual save()', async () => {
    const tenantId = 'test-tenant-456';

    await withTenant({ tenantId }, async () => {
      // Create instance directly (not via collection)
      const build = new Build({
        contractId: 'contract-xyz',
        status: 'active',
        db,
      });
      await build.initialize();

      // Save without tenantId
      await build.save();

      // Verify tenantId was auto-populated
      expect(build.tenantId).toBe(tenantId);

      // Verify it was saved to database
      const loaded = await collection.get({ id: build.id });
      expect(loaded?.tenantId).toBe(tenantId);
    });
  });

  it('should respect explicitly provided tenantId (no override)', async () => {
    const contextTenantId = 'context-tenant';
    const explicitTenantId = 'explicit-tenant';

    await withTenant({ tenantId: contextTenantId }, async () => {
      // This should throw because tenantId mismatch
      await expect(
        collection.create({
          contractId: 'contract-def',
          status: 'pending',
          tenantId: explicitTenantId, // Different from context!
        }),
      ).rejects.toThrow(/isolation violation/i);
    });
  });

  it('should allow matching explicit tenantId', async () => {
    const tenantId = 'matching-tenant';

    await withTenant({ tenantId }, async () => {
      // Explicitly provide same tenantId as context
      const build = await collection.create({
        contractId: 'contract-ghi',
        status: 'completed',
        tenantId, // Same as context
      });

      expect(build.tenantId).toBe(tenantId);
    });
  });

  it('should work with custom tenant field name', async () => {
    // Define class with custom field name
    @smrt({
      tenantScoped: {
        field: 'organizationId',
      },
    })
    class Organization extends SmrtObject {
      name: string = '';
    }

    class OrganizationCollection extends SmrtCollection<Organization> {
      static readonly _itemClass = Organization;
    }

    const orgCollection = await OrganizationCollection.create({
      db,
    });

    const tenantId = 'org-tenant-789';

    await withTenant({ tenantId }, async () => {
      const org = await orgCollection.create({
        name: 'Acme Corp',
        // organizationId should be auto-populated
      });

      expect((org as any).organizationId).toBe(tenantId);
    });
  });

  it('should verify config is read from ObjectRegistry', () => {
    // Verify core registry has the config
    const config = ObjectRegistry.getTenantScopedConfig('Build');
    expect(config).toBeDefined();
    expect(config?.mode).toBe('required');
    expect(config?.field).toBe('tenantId');
    expect(config?.autoFilter).toBe(true);
    expect(config?.autoPopulate).toBe(true);
    expect(config?.allowSuperAdminBypass).toBe(false);
  });

  it('should filter queries by tenant automatically', async () => {
    const tenant1 = 'tenant-001';
    const tenant2 = 'tenant-002';

    // Create builds in different tenants
    await withTenant({ tenantId: tenant1 }, async () => {
      await collection.create({
        contractId: 'contract-t1-1',
        status: 'pending',
      });
      await collection.create({
        contractId: 'contract-t1-2',
        status: 'active',
      });
    });

    await withTenant({ tenantId: tenant2 }, async () => {
      await collection.create({
        contractId: 'contract-t2-1',
        status: 'pending',
      });
    });

    // Query in tenant1 context - should only see tenant1 builds
    await withTenant({ tenantId: tenant1 }, async () => {
      const builds = await collection.list({});
      expect(builds).toHaveLength(2);
      for (const build of builds) {
        expect(build.tenantId).toBe(tenant1);
      }
    });

    // Query in tenant2 context - should only see tenant2 builds
    await withTenant({ tenantId: tenant2 }, async () => {
      const builds = await collection.list({});
      expect(builds).toHaveLength(1);
      expect(builds[0].tenantId).toBe(tenant2);
    });
  });
});
