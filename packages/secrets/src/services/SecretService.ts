/**
 * SecretService - High-level API for per-tenant secret management
 * @packageDocumentation
 */

import {
  type EncryptedEnvelope,
  getSecretStore,
  type SecretStore,
} from '@happyvertical/secrets';
import { getCurrentTenant, requireTenantId } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { SecretAuditLogCollection } from '../collections/SecretAuditLogCollection.js';
import { SecretCollection } from '../collections/SecretCollection.js';
import type { Secret } from '../models/Secret.js';
import {
  createAuditEntry,
  type SecretAuditAction,
  type SecretAuditLog,
} from '../models/SecretAuditLog.js';

/**
 * Options for creating a SecretService
 */
export interface SecretServiceOptions {
  /** Database connection */
  db: DatabaseInterface;
  /** Environment variable containing the AMK (64 hex chars) */
  amkEnvVar?: string;
  /** AMK key identifier */
  amkKeyId?: string;
  /** Enable audit logging (default: true) */
  auditEnabled?: boolean;
}

/**
 * Options for storing a secret
 */
export interface StoreSecretOptions {
  /** Human-readable description */
  description?: string;
  /** Category for organization */
  category?: string;
  /** Optional expiration date */
  expiresAt?: Date;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Result of retrieving a secret
 */
export interface RetrievedSecret {
  /** The decrypted secret value */
  value: string;
  /** Secret metadata */
  name: string;
  description: string;
  category: string;
  expiresAt: Date | null;
  createdAt: Date;
  lastAccessedAt: Date | null;
  accessCount: number;
  metadata: Record<string, unknown>;
}

/**
 * SecretService provides high-level operations for managing per-tenant secrets.
 *
 * It integrates with:
 * - `@happyvertical/secrets` for envelope encryption
 * - `@happyvertical/smrt-tenancy` for tenant context
 * - Audit logging for compliance
 *
 * @example
 * ```typescript
 * import { SecretService } from '@happyvertical/smrt-secrets';
 * import { withTenant } from '@happyvertical/smrt-tenancy';
 *
 * const service = await SecretService.create({ db });
 *
 * await withTenant({ tenantId: 'tenant-123' }, async () => {
 *   // Store a secret
 *   await service.store('stripe-api-key', 'sk_live_xxx', {
 *     category: 'api-keys',
 *     description: 'Stripe production API key'
 *   });
 *
 *   // Retrieve the secret
 *   const secret = await service.retrieve('stripe-api-key');
 *   console.log(secret.value); // 'sk_live_xxx'
 *
 *   // List secret names (without values)
 *   const secrets = await service.list();
 *
 *   // Rotate tenant's encryption key
 *   await service.rotateKey();
 *
 *   // Delete a secret
 *   await service.delete('stripe-api-key');
 * });
 * ```
 */
export class SecretService {
  private secretStore: SecretStore;
  private secrets: SecretCollection;
  private auditLogs: SecretAuditLogCollection;
  private auditEnabled: boolean;

  private constructor(
    secretStore: SecretStore,
    secrets: SecretCollection,
    auditLogs: SecretAuditLogCollection,
    auditEnabled: boolean,
  ) {
    this.secretStore = secretStore;
    this.secrets = secrets;
    this.auditLogs = auditLogs;
    this.auditEnabled = auditEnabled;
  }

  /**
   * Create a new SecretService instance
   */
  static async create(options: SecretServiceOptions): Promise<SecretService> {
    const {
      db,
      amkEnvVar = 'SMRT_SECRET_MASTER_KEY',
      amkKeyId = 'smrt-amk-v1',
      auditEnabled = true,
    } = options;

    // Create the underlying secret store
    const secretStore = await getSecretStore({
      type: 'database',
      db,
      amk: {
        provider: 'env',
        keyEnvVar: amkEnvVar,
        keyId: amkKeyId,
      },
    });

    // Create collections - pass db directly (DatabaseConfig accepts DatabaseInterface)
    const baseOptions = { db };
    const secrets = await SecretCollection.create(baseOptions);
    const auditLogs = await SecretAuditLogCollection.create(baseOptions);

    return new SecretService(secretStore, secrets, auditLogs, auditEnabled);
  }

  /**
   * Store a secret for the current tenant
   */
  async store(
    name: string,
    value: string,
    options: StoreSecretOptions = {},
  ): Promise<Secret> {
    const tenantId = requireTenantId();
    const userId = this.getCurrentUserId();

    // Track whether this is an update to use correct audit action on error
    let isUpdate = false;

    try {
      // Check if secret already exists
      const existing = await this.secrets.findByName(name);
      isUpdate = existing !== null;

      // Encrypt the value
      const envelope = await this.secretStore.encrypt(tenantId, name, value, {
        metadata: options.metadata
          ? this.serializeMetadata(options.metadata)
          : undefined,
      });

      if (existing) {
        // Update existing secret
        existing.encryptedValue = JSON.stringify(envelope);
        existing.description = options.description ?? existing.description;
        existing.category = options.category ?? existing.category;
        existing.expiresAt = options.expiresAt ?? existing.expiresAt;
        existing.metadata = options.metadata ?? existing.metadata;
        await existing.save();

        await this.audit(
          existing.id ?? null,
          name,
          userId,
          'update',
          'success',
        );
        return existing;
      }

      // Create new secret
      // Set context to tenantId for per-tenant uniqueness
      // The UPSERT uses (slug, context) as conflict columns, so different tenants
      // can have secrets with the same name
      const secret = await this.secrets.create({
        name,
        description: options.description ?? '',
        category: options.category ?? '',
        encryptedValue: JSON.stringify(envelope),
        keyVersion: 1,
        status: 'active',
        expiresAt: options.expiresAt ?? null,
        metadata: options.metadata ?? {},
        context: tenantId, // Per-tenant uniqueness
        tenantId,
      });
      (secret as Secret & { tenantId?: string | null }).tenantId = tenantId;
      await secret.save();

      await this.audit(secret.id ?? null, name, userId, 'create', 'success');
      return secret;
    } catch (error) {
      await this.audit(
        null,
        name,
        userId,
        isUpdate ? 'update' : 'create',
        'failure',
        {
          error: (error as Error).message,
        },
      );
      throw error;
    }
  }

  /**
   * Retrieve a secret for the current tenant
   */
  async retrieve(name: string): Promise<RetrievedSecret> {
    const tenantId = requireTenantId();
    const userId = this.getCurrentUserId();

    // Track whether we've already audited to avoid double-auditing
    let audited = false;

    try {
      const secret = await this.secrets.findByName(name);
      if (!secret) {
        await this.audit(null, name, userId, 'read', 'failure', {
          error: 'Secret not found',
        });
        audited = true;
        throw new Error(`Secret '${name}' not found`);
      }

      if (!secret.isUsable()) {
        const reason = secret.isExpired()
          ? 'Secret expired'
          : 'Secret disabled';
        await this.audit(secret.id ?? null, name, userId, 'read', 'failure', {
          error: reason,
        });
        audited = true;
        throw new Error(reason);
      }

      // Decrypt the value
      const envelope: EncryptedEnvelope = JSON.parse(secret.encryptedValue);
      const decrypted = await this.secretStore.decrypt(tenantId, envelope);

      // Update access tracking
      secret.recordAccess();
      await secret.save();

      await this.audit(secret.id ?? null, name, userId, 'read', 'success');

      return {
        value: decrypted.value,
        name: secret.name,
        description: secret.description,
        category: secret.category,
        expiresAt: secret.expiresAt,
        createdAt: secret.created_at ?? new Date(),
        lastAccessedAt: secret.lastAccessedAt,
        accessCount: secret.accessCount,
        metadata: secret.metadata,
      };
    } catch (error) {
      // Only audit if we haven't already audited this error
      if (!audited) {
        await this.audit(null, name, userId, 'read', 'failure', {
          error: (error as Error).message,
        });
      }
      throw error;
    }
  }

  /**
   * List secrets for the current tenant (names only, not values)
   */
  async list(options: { category?: string } = {}): Promise<Secret[]> {
    return this.secrets.listSecrets({
      category: options.category,
      status: 'active',
    });
  }

  /**
   * Delete a secret
   */
  async delete(name: string): Promise<boolean> {
    const userId = this.getCurrentUserId();

    const secret = await this.secrets.findByName(name);
    if (!secret) {
      return false;
    }

    try {
      await secret.delete();
      await this.audit(secret.id ?? null, name, userId, 'delete', 'success');
      return true;
    } catch (error) {
      await this.audit(secret.id ?? null, name, userId, 'delete', 'failure', {
        error: (error as Error).message,
      });
      throw error;
    }
  }

  /**
   * Disable a secret (soft delete)
   */
  async disable(name: string): Promise<boolean> {
    const userId = this.getCurrentUserId();

    const secret = await this.secrets.findByName(name);
    if (!secret) {
      return false;
    }

    secret.disable();
    await secret.save();
    await this.audit(secret.id ?? null, name, userId, 'disable', 'success');
    return true;
  }

  /**
   * Enable a disabled secret
   */
  async enable(name: string): Promise<boolean> {
    const userId = this.getCurrentUserId();

    const secret = await this.secrets.findByName(name);
    if (!secret) {
      return false;
    }

    secret.enable();
    await secret.save();
    await this.audit(secret.id ?? null, name, userId, 'enable', 'success');
    return true;
  }

  /**
   * Rotate the tenant's encryption key
   *
   * This creates a new TDEK and marks the old one as retired.
   * Existing secrets remain encrypted with the old key and can still
   * be decrypted (the old key is kept in retired state).
   *
   * For full re-encryption, call reencryptAll() after rotation.
   */
  async rotateKey(): Promise<void> {
    const tenantId = requireTenantId();
    const userId = this.getCurrentUserId();

    try {
      await this.secretStore.rotateTenantKey(tenantId);
      await this.audit(null, '', userId, 'rotate_key', 'success', {
        tenantId,
      });
    } catch (error) {
      await this.audit(null, '', userId, 'rotate_key', 'failure', {
        tenantId,
        error: (error as Error).message,
      });
      throw error;
    }
  }

  /**
   * Re-encrypt all secrets with the current active key
   *
   * Call this after key rotation to ensure all secrets use the new key.
   * This is optional but recommended for security.
   */
  async reencryptAll(): Promise<{ success: number; failed: number }> {
    const tenantId = requireTenantId();
    const userId = this.getCurrentUserId();

    const secrets = await this.secrets.list({});
    let success = 0;
    let failed = 0;

    for (const secret of secrets) {
      try {
        // Decrypt with old key
        const envelope: EncryptedEnvelope = JSON.parse(secret.encryptedValue);
        const decrypted = await this.secretStore.decrypt(tenantId, envelope);

        // Re-encrypt with new key
        const newEnvelope = await this.secretStore.encrypt(
          tenantId,
          secret.name,
          decrypted.value,
        );

        secret.encryptedValue = JSON.stringify(newEnvelope);
        await secret.save();

        success++;
      } catch (error) {
        failed++;
        await this.audit(
          secret.id ?? null,
          secret.name,
          userId,
          'update',
          'failure',
          {
            action: 'reencrypt',
            error: (error as Error).message,
          },
        );
      }
    }

    return { success, failed };
  }

  /**
   * Get audit logs for the current tenant
   */
  async getAuditLogs(
    options: { secretName?: string; limit?: number } = {},
  ): Promise<SecretAuditLog[]> {
    return this.auditLogs.listLogs({
      secretName: options.secretName,
      limit: options.limit ?? 100,
    });
  }

  /**
   * Get secret categories for the current tenant
   */
  async getCategories(): Promise<string[]> {
    return this.secrets.getCategories();
  }

  /**
   * Check if a secret exists
   */
  async exists(name: string): Promise<boolean> {
    const secret = await this.secrets.findByName(name);
    return secret !== null;
  }

  // Private methods

  private getCurrentUserId(): string {
    const ctx = getCurrentTenant();
    return ctx?.userId ?? 'system';
  }

  private async audit(
    secretId: string | null,
    secretName: string,
    userId: string,
    action: SecretAuditAction,
    result: 'success' | 'failure' | 'denied',
    details?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.auditEnabled) return;

    try {
      const tenantId = getCurrentTenant()?.tenantId;
      const log = await this.auditLogs.create(
        createAuditEntry({
          secretId,
          secretName,
          userId,
          action,
          result,
          details,
          tenantId,
        }),
      );
      await log.save();
    } catch (error) {
      // Don't throw on audit failure - log and continue
      console.error('Failed to write audit log:', error);
    }
  }

  private serializeMetadata(
    metadata: Record<string, unknown>,
  ): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(metadata)) {
      result[key] = typeof value === 'string' ? value : JSON.stringify(value);
    }
    return result;
  }
}
