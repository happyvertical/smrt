/**
 * SecretService Tests
 *
 * Tests for per-tenant secret management:
 * 1. Basic secret storage and retrieval
 * 2. Tenant isolation (secrets scoped to tenant)
 * 3. Secret lifecycle (enable/disable/delete)
 * 4. Key rotation and re-encryption
 * 5. Audit logging
 */

import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SecretCollection } from '../collections/SecretCollection.js';
import { SecretService } from '../services/SecretService.js';

// Test AMK (64 hex chars = 32 bytes)
const TEST_AMK =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

describe('SecretService', () => {
  let db: DatabaseInterface;
  let service: SecretService;

  beforeEach(async () => {
    // Enable tenancy for tests
    enableTenancy();

    // Set test AMK
    process.env.SMRT_SECRET_MASTER_KEY = TEST_AMK;

    // Create test database with all schemas pre-created
    db = await getTestDatabase();

    // Create service
    service = await SecretService.create({ db });
  });

  afterEach(() => {
    disableTenancy();
    delete process.env.SMRT_SECRET_MASTER_KEY;
  });

  describe('Basic operations', () => {
    it('should store and retrieve a secret', async () => {
      await withTenant({ tenantId: 'tenant-1' }, async () => {
        // Store a secret
        const secret = await service.store('api-key', 'sk_test_123', {
          category: 'api',
          description: 'Test API key',
        });

        expect(secret).toBeDefined();
        expect(secret.name).toBe('api-key');
        expect(secret.category).toBe('api');
        expect(secret.description).toBe('Test API key');

        // Retrieve the secret
        const retrieved = await service.retrieve('api-key');
        expect(retrieved.value).toBe('sk_test_123');
        expect(retrieved.name).toBe('api-key');
        expect(retrieved.accessCount).toBe(1);
      });
    });

    it('returns decrypted secrets when access tracking cannot be persisted', async () => {
      await withTenant({ tenantId: 'tenant-1' }, async () => {
        await service.store('api-key', 'sk_test_123');

        const originalFindByName = SecretCollection.prototype.findByName;
        const findByName = vi
          .spyOn(SecretCollection.prototype, 'findByName')
          .mockImplementation(async function (name: string) {
            const secret = await originalFindByName.call(this, name);
            if (name === 'api-key' && secret) {
              secret.save = vi.fn(async () => {
                throw new Error('tracking write failed');
              });
            }
            return secret;
          });
        const consoleError = vi
          .spyOn(console, 'error')
          .mockImplementation(() => {});

        try {
          const retrieved = await service.retrieve('api-key');

          expect(retrieved.value).toBe('sk_test_123');
          expect(consoleError).toHaveBeenCalledWith(
            'Failed to update secret access tracking:',
            expect.any(Error),
          );
        } finally {
          findByName.mockRestore();
          consoleError.mockRestore();
        }
      });
    });

    it('should update an existing secret', async () => {
      await withTenant({ tenantId: 'tenant-1' }, async () => {
        // Store initial secret
        await service.store('api-key', 'initial-value');

        // Update with new value
        await service.store('api-key', 'updated-value', {
          category: 'updated-category',
        });

        // Verify update
        const retrieved = await service.retrieve('api-key');
        expect(retrieved.value).toBe('updated-value');
        expect(retrieved.category).toBe('updated-category');
      });
    });

    it('should list secrets without exposing values', async () => {
      await withTenant({ tenantId: 'tenant-1' }, async () => {
        await service.store('secret-1', 'value-1', { category: 'api' });
        await service.store('secret-2', 'value-2', { category: 'api' });
        await service.store('secret-3', 'value-3', { category: 'db' });

        // List all
        const allSecrets = await service.list();
        expect(allSecrets.length).toBe(3);

        // List by category
        const apiSecrets = await service.list({ category: 'api' });
        expect(apiSecrets.length).toBe(2);
      });
    });

    it('should check if a secret exists', async () => {
      await withTenant({ tenantId: 'tenant-1' }, async () => {
        await service.store('existing-secret', 'value');

        expect(await service.exists('existing-secret')).toBe(true);
        expect(await service.exists('non-existent')).toBe(false);
      });
    });

    it('persists tenant-scoped secrets without relying on the tenancy interceptor', async () => {
      disableTenancy();

      await withTenant({ tenantId: 'tenant-1' }, async () => {
        await service.store('interceptor-free-secret', 'value');
      });

      const { rows } = await db.query(
        'SELECT name, tenant_id FROM secrets WHERE name = ?',
        'interceptor-free-secret',
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.name).toBe('interceptor-free-secret');
      expect(rows[0]?.tenant_id).toBe('tenant-1');
    });

    it('can store and retrieve with an explicit tenant id', async () => {
      disableTenancy();

      await service.storeForTenant('tenant-1', 'explicit-secret', 'value', {
        category: 'oauth',
      });

      const retrieved = await service.retrieveForTenant(
        'tenant-1',
        'explicit-secret',
      );

      expect(retrieved.value).toBe('value');
      expect(retrieved.category).toBe('oauth');
    });
  });

  describe('Secret lifecycle', () => {
    it('should disable and enable a secret', async () => {
      await withTenant({ tenantId: 'tenant-1' }, async () => {
        await service.store('api-key', 'secret-value');

        // Disable
        await service.disable('api-key');

        // Should fail to retrieve
        await expect(service.retrieve('api-key')).rejects.toThrow(
          'Secret disabled',
        );

        // Enable
        await service.enable('api-key');

        // Should retrieve again
        const retrieved = await service.retrieve('api-key');
        expect(retrieved.value).toBe('secret-value');
      });
    });

    it('should delete a secret', async () => {
      await withTenant({ tenantId: 'tenant-1' }, async () => {
        await service.store('to-delete', 'value');
        expect(await service.exists('to-delete')).toBe(true);

        await service.delete('to-delete');
        expect(await service.exists('to-delete')).toBe(false);
      });
    });

    it('should handle expired secrets', async () => {
      await withTenant({ tenantId: 'tenant-1' }, async () => {
        // Store with past expiration
        const pastDate = new Date(Date.now() - 86400000); // 1 day ago
        await service.store('expired-secret', 'value', {
          expiresAt: pastDate,
        });

        // Should fail to retrieve
        await expect(service.retrieve('expired-secret')).rejects.toThrow(
          'Secret expired',
        );
      });
    });
  });

  describe('Tenant isolation', () => {
    it('should isolate secrets between tenants', async () => {
      // Store secrets for tenant-1
      await withTenant({ tenantId: 'tenant-1' }, async () => {
        await service.store('shared-name', 'tenant-1-value');
      });

      // Store secrets for tenant-2
      await withTenant({ tenantId: 'tenant-2' }, async () => {
        await service.store('shared-name', 'tenant-2-value');
      });

      // Verify tenant-1 sees its own secret
      await withTenant({ tenantId: 'tenant-1' }, async () => {
        const retrieved = await service.retrieve('shared-name');
        expect(retrieved.value).toBe('tenant-1-value');
      });

      // Verify tenant-2 sees its own secret
      await withTenant({ tenantId: 'tenant-2' }, async () => {
        const retrieved = await service.retrieve('shared-name');
        expect(retrieved.value).toBe('tenant-2-value');
      });
    });

    it('should not list secrets from other tenants', async () => {
      await withTenant({ tenantId: 'tenant-1' }, async () => {
        await service.store('tenant-1-secret', 'value');
      });

      await withTenant({ tenantId: 'tenant-2' }, async () => {
        await service.store('tenant-2-secret', 'value');
      });

      // Tenant-1 should only see its secrets
      await withTenant({ tenantId: 'tenant-1' }, async () => {
        const secrets = await service.list();
        expect(secrets.length).toBe(1);
        expect(secrets[0].name).toBe('tenant-1-secret');
      });
    });
  });

  describe('Key rotation', () => {
    it('should rotate tenant key', async () => {
      await withTenant({ tenantId: 'tenant-1' }, async () => {
        // Store a secret
        await service.store('api-key', 'secret-value');

        // Rotate key
        await service.rotateKey();

        // Should still be able to retrieve (old key retained)
        const retrieved = await service.retrieve('api-key');
        expect(retrieved.value).toBe('secret-value');
      });
    });

    it('should re-encrypt all secrets after rotation', async () => {
      await withTenant({ tenantId: 'tenant-1' }, async () => {
        // Store secrets
        await service.store('secret-1', 'value-1');
        await service.store('secret-2', 'value-2');

        // Rotate and re-encrypt
        await service.rotateKey();
        const result = await service.reencryptAll();

        expect(result.success).toBe(2);
        expect(result.failed).toBe(0);

        // Verify secrets still accessible
        expect((await service.retrieve('secret-1')).value).toBe('value-1');
        expect((await service.retrieve('secret-2')).value).toBe('value-2');
      });
    });
  });

  describe('Audit logging', () => {
    it('should log secret operations', async () => {
      await withTenant({ tenantId: 'tenant-1' }, async () => {
        // Perform operations
        await service.store('audit-test', 'value');
        await service.retrieve('audit-test');
        await service.delete('audit-test');

        // Check audit logs
        const logs = await service.getAuditLogs({ secretName: 'audit-test' });
        expect(logs.length).toBeGreaterThanOrEqual(3);

        // Verify actions logged
        const actions = logs.map((l) => l.action);
        expect(actions).toContain('create');
        expect(actions).toContain('read');
        expect(actions).toContain('delete');
      });
    });

    it('should log failed operations', async () => {
      await withTenant({ tenantId: 'tenant-1' }, async () => {
        // Try to retrieve non-existent secret
        await expect(service.retrieve('non-existent')).rejects.toThrow();

        // Check audit logs for failure
        const logs = await service.getAuditLogs({ secretName: 'non-existent' });
        expect(logs.length).toBeGreaterThan(0);
        expect(logs[0].result).toBe('failure');
      });
    });

    it('persists tenant-scoped audit failures without relying on the tenancy interceptor', async () => {
      disableTenancy();

      await withTenant({ tenantId: 'tenant-1' }, async () => {
        await expect(service.retrieve('missing-secret')).rejects.toThrow(
          "Secret 'missing-secret' not found",
        );
      });

      const { rows } = await db.query(
        'SELECT secret_name, result, tenant_id FROM secret_audit_logs WHERE secret_name = ?',
        'missing-secret',
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]?.secret_name).toBe('missing-secret');
      expect(rows[0]?.result).toBe('failure');
      expect(rows[0]?.tenant_id).toBe('tenant-1');
    });
  });

  describe('Categories', () => {
    it('should return unique categories', async () => {
      await withTenant({ tenantId: 'tenant-1' }, async () => {
        await service.store('s1', 'v1', { category: 'api' });
        await service.store('s2', 'v2', { category: 'api' });
        await service.store('s3', 'v3', { category: 'database' });
        await service.store('s4', 'v4', { category: 'service' });

        const categories = await service.getCategories();
        expect(categories.sort()).toEqual(['api', 'database', 'service']);
      });
    });
  });
});

describe('Secret Model', () => {
  let db: DatabaseInterface;
  let secrets: SecretCollection;

  beforeEach(async () => {
    enableTenancy();
    db = await getTestDatabase();
    secrets = await SecretCollection.create({ db });
  });

  afterEach(() => {
    disableTenancy();
  });

  it('should track access count', async () => {
    await withTenant({ tenantId: 'test-tenant' }, async () => {
      const secret = await secrets.create({
        name: 'test-secret',
        encryptedValue: 'encrypted',
        keyVersion: 1,
        status: 'active',
      });
      await secret.save();

      expect(secret.accessCount).toBe(0);

      secret.recordAccess();
      expect(secret.accessCount).toBe(1);
      expect(secret.lastAccessedAt).toBeDefined();

      secret.recordAccess();
      expect(secret.accessCount).toBe(2);
    });
  });

  it('should check usability based on status and expiry', async () => {
    await withTenant({ tenantId: 'test-tenant' }, async () => {
      const activeSecret = await secrets.create({
        name: 'active',
        encryptedValue: 'encrypted',
        keyVersion: 1,
        status: 'active',
      });
      await activeSecret.save();
      expect(activeSecret.isUsable()).toBe(true);

      const disabledSecret = await secrets.create({
        name: 'disabled',
        encryptedValue: 'encrypted',
        keyVersion: 1,
        status: 'disabled',
      });
      await disabledSecret.save();
      expect(disabledSecret.isUsable()).toBe(false);

      const expiredSecret = await secrets.create({
        name: 'expired',
        encryptedValue: 'encrypted',
        keyVersion: 1,
        status: 'active',
        expiresAt: new Date(Date.now() - 1000),
      });
      await expiredSecret.save();
      expect(expiredSecret.isUsable()).toBe(false);
      expect(expiredSecret.isExpired()).toBe(true);
    });
  });
});
