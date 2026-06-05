/**
 * SecretService - High-level API for per-tenant secret management
 * @packageDocumentation
 */

// Self-register this package's manifest for consumers that import via this
// subpath without the main entry. See src/__smrt-register__.ts (issue #1132).
import '../__smrt-register__.js';

import {
  AMKUnavailableError,
  DecryptionError,
  type EncryptedEnvelope,
  EncryptionError,
  EnvelopeEncryption,
  getSecretStore,
  type SecretStore,
  TenantKeyMissingError,
} from '@happyvertical/secrets';
import {
  getCurrentTenant,
  requireTenantId,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { SecretAuditLogCollection } from '../collections/SecretAuditLogCollection.js';
import { SecretCollection } from '../collections/SecretCollection.js';
import { TenantKeyCollection } from '../collections/TenantKeyCollection.js';
import type { Secret } from '../models/Secret.js';
import {
  createAuditEntry,
  type SecretAuditAction,
  type SecretAuditLog,
} from '../models/SecretAuditLog.js';
import type { TenantKey } from '../models/TenantKey.js';

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

export type SecretKeyDriftIssueSeverity = 'info' | 'warning' | 'error';

export type SecretKeyDriftIssueCode =
  | 'amk_unavailable'
  | 'active_secrets_without_usable_active_key'
  | 'missing_active_tenant_encryption_key'
  | 'multiple_active_tenant_encryption_keys'
  | 'active_tenant_encryption_key_amk_mismatch'
  | 'active_tenant_encryption_key_unwrap_failed'
  | 'secret_envelope_invalid_json'
  | 'secret_envelope_invalid_wrapped_key'
  | 'secret_envelope_missing_tenant_encryption_key'
  | 'secret_envelope_unwrap_failed'
  | 'smrt_tenant_keys_not_mirrored';

export type SecretKeyDriftRepairAction =
  | 'delete-unrecoverable-secret'
  | 'delete-unusable-tenant-encryption-key'
  | 'store-fresh-secret-value'
  | 'none';

export interface SecretKeyDriftIssue {
  code: SecretKeyDriftIssueCode;
  severity: SecretKeyDriftIssueSeverity;
  message: string;
  repairAction: SecretKeyDriftRepairAction;
  secretId?: string;
  secretName?: string;
  keyId?: string;
  sourceTable?: 'secrets' | 'tenant_encryption_keys' | 'tenant_keys';
  details?: Record<string, string | number | boolean | null>;
}

export interface DiagnoseTenantSecretKeyDriftOptions {
  /**
   * Limit secret-envelope checks to these names. Tenant key checks still run.
   */
  secretNames?: string[];
}

export interface SecretKeyDriftReport {
  tenantId: string;
  checkedAt: Date;
  ok: boolean;
  summary: {
    activeSecretCount: number;
    tenantEncryptionKeyCount: number;
    activeTenantEncryptionKeyCount: number;
    usableActiveTenantEncryptionKeyCount: number;
    smrtTenantKeyCount: number;
    activeSmrtTenantKeyCount: number;
  };
  issues: SecretKeyDriftIssue[];
}

export interface RepairTenantSecretKeyDriftOptions
  extends DiagnoseTenantSecretKeyDriftOptions {
  /**
   * Preview affected rows without deleting anything.
   */
  dryRun?: boolean;
  /**
   * Required for destructive repair. This deletes encrypted values/key rows
   * that cannot be used with the currently configured AMK.
   */
  confirmDeleteUnrecoverableData?: boolean;
}

export interface SecretKeyDriftRepairResult {
  tenantId: string;
  dryRun: boolean;
  issuesBefore: SecretKeyDriftIssue[];
  remainingIssues: SecretKeyDriftIssue[];
  wouldDeleteSecrets: number;
  wouldDeleteTenantEncryptionKeys: number;
  deletedSecrets: number;
  deletedTenantEncryptionKeys: number;
  secretNames: string[];
  tenantEncryptionKeyIds: string[];
}

export class SecretKeyDriftError extends Error {
  readonly code = 'SECRET_KEY_DRIFT';
  readonly tenantId: string;
  readonly report: SecretKeyDriftReport;
  readonly cause?: Error;

  constructor(
    message: string,
    tenantId: string,
    report: SecretKeyDriftReport,
    cause?: Error,
  ) {
    super(message);
    this.name = 'SecretKeyDriftError';
    this.tenantId = tenantId;
    this.report = report;
    this.cause = cause;
  }
}

interface TenantEncryptionKeyRow {
  id: string;
  tenant_id: string;
  wrapped_key: string;
  amk_key_id: string;
  status: string;
  version: number;
  rotate_after: string | null;
  retired_at: string | null;
  created_at: string;
  updated_at: string;
}

interface SecretDiagnosisRow {
  id: string;
  name: string;
  encrypted_value: string;
  status: string;
  tenant_id: string;
}

interface WrappedKeyCheck {
  usable: boolean;
  error?: string;
  fingerprint?: string;
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
  private db: DatabaseInterface;
  private secretStore: SecretStore;
  private secrets: SecretCollection;
  private tenantKeys: TenantKeyCollection;
  private auditLogs: SecretAuditLogCollection;
  private auditEnabled: boolean;
  private amkEnvVar: string;
  private amkKeyId: string;

  private constructor(
    db: DatabaseInterface,
    secretStore: SecretStore,
    secrets: SecretCollection,
    tenantKeys: TenantKeyCollection,
    auditLogs: SecretAuditLogCollection,
    auditEnabled: boolean,
    amkEnvVar: string,
    amkKeyId: string,
  ) {
    this.db = db;
    this.secretStore = secretStore;
    this.secrets = secrets;
    this.tenantKeys = tenantKeys;
    this.auditLogs = auditLogs;
    this.auditEnabled = auditEnabled;
    this.amkEnvVar = amkEnvVar;
    this.amkKeyId = amkKeyId;
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
    const tenantKeys = await TenantKeyCollection.create(baseOptions);
    const auditLogs = await SecretAuditLogCollection.create(baseOptions);

    return new SecretService(
      db,
      secretStore,
      secrets,
      tenantKeys,
      auditLogs,
      auditEnabled,
      amkEnvVar,
      amkKeyId,
    );
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

      await this.audit(secret.id ?? null, name, userId, 'create', 'success');
      return secret;
    } catch (error) {
      const classifiedError = await this.classifyTenantKeyFailure(
        tenantId,
        name,
        error,
      );
      await this.audit(
        null,
        name,
        userId,
        isUpdate ? 'update' : 'create',
        'failure',
        {
          error: classifiedError.message,
        },
      );
      throw classifiedError;
    }
  }

  /**
   * Store a secret for a specific tenant.
   *
   * This is useful for integrations that already resolved tenant ownership but
   * may be running outside the application's ambient tenant context.
   */
  async storeForTenant(
    tenantId: string,
    name: string,
    value: string,
    options: StoreSecretOptions = {},
  ): Promise<Secret> {
    return withTenant({ tenantId }, () => this.store(name, value, options));
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

      // Access tracking is operational telemetry. Retrieval should still
      // succeed if the decrypted value is available but this write fails.
      const previousLastAccessedAt = secret.lastAccessedAt;
      const previousAccessCount = secret.accessCount;
      try {
        secret.recordAccess();
        await secret.save();
      } catch (trackingError) {
        secret.lastAccessedAt = previousLastAccessedAt;
        secret.accessCount = previousAccessCount;
        console.error(
          'Failed to update secret access tracking:',
          trackingError,
        );
      }

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
      const classifiedError = await this.classifyTenantKeyFailure(
        tenantId,
        name,
        error,
      );
      // Only audit if we haven't already audited this error
      if (!audited) {
        await this.audit(null, name, userId, 'read', 'failure', {
          error: classifiedError.message,
        });
      }
      throw classifiedError;
    }
  }

  /**
   * Retrieve a secret for a specific tenant.
   */
  async retrieveForTenant(
    tenantId: string,
    name: string,
  ): Promise<RetrievedSecret> {
    return withTenant({ tenantId }, () => this.retrieve(name));
  }

  /**
   * Diagnose tenant secret/key drift without exposing decrypted values.
   */
  async diagnoseTenantSecretKeyDrift(
    tenantId: string,
    options: DiagnoseTenantSecretKeyDriftOptions = {},
  ): Promise<SecretKeyDriftReport> {
    const activeSecrets = await this.listActiveSecretRowsForDiagnosis(
      tenantId,
      options.secretNames,
    );
    const tenantEncryptionKeys =
      await this.listTenantEncryptionKeyRows(tenantId);
    const smrtTenantKeys = await this.listSmrtTenantKeysForDiagnosis(tenantId);
    const issues: SecretKeyDriftIssue[] = [];

    const activeTenantEncryptionKeys = tenantEncryptionKeys.filter(
      (key) => key.status === 'active',
    );
    const activeSmrtTenantKeys = smrtTenantKeys.filter(
      (key) => key.status === 'active',
    );
    const amk = this.getConfiguredAmkForDiagnosis();

    if (!amk.usable) {
      issues.push({
        code: 'amk_unavailable',
        severity: 'error',
        message: amk.error ?? `AMK ${this.amkEnvVar} is unavailable`,
        repairAction: 'none',
        details: {
          amkEnvVar: this.amkEnvVar,
          amkKeyId: this.amkKeyId,
        },
      });
    }

    if (activeSecrets.length > 0 && activeTenantEncryptionKeys.length === 0) {
      issues.push({
        code: 'missing_active_tenant_encryption_key',
        severity: 'error',
        message:
          'Active tenant secrets exist, but tenant_encryption_keys has no active key for encryption.',
        repairAction: 'store-fresh-secret-value',
        sourceTable: 'tenant_encryption_keys',
        details: {
          activeSecretCount: activeSecrets.length,
        },
      });
    }

    if (activeTenantEncryptionKeys.length > 1) {
      issues.push({
        code: 'multiple_active_tenant_encryption_keys',
        severity: 'error',
        message:
          'tenant_encryption_keys has multiple active keys for this tenant; encryption may use an arbitrary active key.',
        repairAction: 'none',
        sourceTable: 'tenant_encryption_keys',
        details: {
          activeTenantEncryptionKeyCount: activeTenantEncryptionKeys.length,
        },
      });
    }

    const activeKeyChecks: WrappedKeyCheck[] = [];

    for (const key of tenantEncryptionKeys) {
      const check = amk.value
        ? this.checkWrappedKey(key.wrapped_key, amk.value)
        : { usable: false, error: amk.error };

      if (key.status === 'active') {
        activeKeyChecks.push(check);
      }

      if (key.status === 'active' && key.amk_key_id !== this.amkKeyId) {
        issues.push({
          code: 'active_tenant_encryption_key_amk_mismatch',
          severity: 'warning',
          message:
            'Active tenant_encryption_keys row was wrapped by a different AMK key id than this SecretService is configured to use.',
          repairAction: 'none',
          keyId: key.id,
          sourceTable: 'tenant_encryption_keys',
          details: {
            rowAmkKeyId: key.amk_key_id,
            configuredAmkKeyId: this.amkKeyId,
          },
        });
      }

      if (key.status === 'active' && !check.usable && amk.value) {
        issues.push({
          code: 'active_tenant_encryption_key_unwrap_failed',
          severity: 'error',
          message:
            'Active tenant_encryption_keys row cannot be unwrapped by the currently configured AMK.',
          repairAction: 'delete-unusable-tenant-encryption-key',
          keyId: key.id,
          sourceTable: 'tenant_encryption_keys',
          details: {
            version: key.version,
            error: check.error ?? null,
          },
        });
      }
    }

    const usableActiveTenantEncryptionKeyCount = activeKeyChecks.filter(
      (check) => check.usable,
    ).length;

    if (
      activeSecrets.length > 0 &&
      usableActiveTenantEncryptionKeyCount === 0
    ) {
      issues.push({
        code: 'active_secrets_without_usable_active_key',
        severity: 'error',
        message:
          'Active secrets exist, but no active tenant_encryption_keys row can be used with the current AMK.',
        repairAction: 'store-fresh-secret-value',
        sourceTable: 'tenant_encryption_keys',
        details: {
          activeSecretCount: activeSecrets.length,
          activeTenantEncryptionKeyCount: activeTenantEncryptionKeys.length,
        },
      });
    }

    const keyFingerprintToRow = new Map<string, TenantEncryptionKeyRow>();
    for (const key of tenantEncryptionKeys) {
      const fingerprint = this.getWrappedKeyFingerprint(key.wrapped_key);
      if (fingerprint) {
        keyFingerprintToRow.set(fingerprint, key);
      }
    }

    for (const secret of activeSecrets) {
      const envelope = this.parseSecretEnvelopeForDiagnosis(secret, issues);
      if (!envelope) continue;

      const envelopeCheck = amk.value
        ? this.checkWrappedKey(envelope.wrappedKey, amk.value)
        : { usable: false, error: amk.error };

      if (!envelopeCheck.fingerprint) {
        issues.push({
          code: 'secret_envelope_invalid_wrapped_key',
          severity: 'error',
          message:
            'Secret encryptedValue contains an invalid wrapped key format.',
          repairAction: 'delete-unrecoverable-secret',
          secretId: secret.id,
          secretName: secret.name,
          sourceTable: 'secrets',
          details: {
            error: envelopeCheck.error ?? null,
          },
        });
        continue;
      }

      const matchingKey = keyFingerprintToRow.get(envelopeCheck.fingerprint);
      if (!matchingKey) {
        issues.push({
          code: 'secret_envelope_missing_tenant_encryption_key',
          severity: 'error',
          message:
            'Secret envelope does not match any tenant_encryption_keys row for this tenant.',
          repairAction: envelopeCheck.usable
            ? 'none'
            : 'delete-unrecoverable-secret',
          secretId: secret.id,
          secretName: secret.name,
          sourceTable: 'secrets',
        });
      }

      if (!envelopeCheck.usable && amk.value) {
        issues.push({
          code: 'secret_envelope_unwrap_failed',
          severity: 'error',
          message:
            'Secret envelope cannot be unwrapped by the currently configured AMK.',
          repairAction: 'delete-unrecoverable-secret',
          secretId: secret.id,
          secretName: secret.name,
          keyId: matchingKey?.id,
          sourceTable: 'secrets',
          details: {
            error: envelopeCheck.error ?? null,
          },
        });
      }
    }

    if (
      activeSecrets.length > 0 &&
      tenantEncryptionKeys.length > 0 &&
      smrtTenantKeys.length === 0
    ) {
      issues.push({
        code: 'smrt_tenant_keys_not_mirrored',
        severity: 'info',
        message:
          'SMRT tenant_keys has no rows for this tenant, while the lower-level tenant_encryption_keys table does. SecretService uses tenant_encryption_keys for encryption.',
        repairAction: 'none',
        sourceTable: 'tenant_keys',
      });
    }

    return {
      tenantId,
      checkedAt: new Date(),
      ok: !issues.some((issue) => issue.severity === 'error'),
      summary: {
        activeSecretCount: activeSecrets.length,
        tenantEncryptionKeyCount: tenantEncryptionKeys.length,
        activeTenantEncryptionKeyCount: activeTenantEncryptionKeys.length,
        usableActiveTenantEncryptionKeyCount,
        smrtTenantKeyCount: smrtTenantKeys.length,
        activeSmrtTenantKeyCount: activeSmrtTenantKeys.length,
      },
      issues,
    };
  }

  /**
   * Diagnose drift for the current tenant context.
   */
  async diagnoseCurrentTenantSecretKeyDrift(
    options: DiagnoseTenantSecretKeyDriftOptions = {},
  ): Promise<SecretKeyDriftReport> {
    return this.diagnoseTenantSecretKeyDrift(requireTenantId(), options);
  }

  /**
   * Delete unrecoverable secret/key rows identified by diagnosis.
   *
   * This never attempts to recover or expose secret values. Use dryRun first
   * to preview destructive changes.
   */
  async repairTenantSecretKeyDrift(
    tenantId: string,
    options: RepairTenantSecretKeyDriftOptions = {},
  ): Promise<SecretKeyDriftRepairResult> {
    const dryRun = options.dryRun ?? false;
    const before = await this.diagnoseTenantSecretKeyDrift(tenantId, options);
    const secretIds = new Set<string>();
    const secretNames = new Map<string, string>();
    const tenantEncryptionKeyIds = new Set<string>();

    for (const issue of before.issues) {
      if (
        issue.repairAction === 'delete-unrecoverable-secret' &&
        issue.secretId
      ) {
        secretIds.add(issue.secretId);
        if (issue.secretName) {
          secretNames.set(issue.secretId, issue.secretName);
        }
      }

      if (
        issue.repairAction === 'delete-unusable-tenant-encryption-key' &&
        issue.keyId
      ) {
        tenantEncryptionKeyIds.add(issue.keyId);
      }
    }

    const wouldDeleteSecrets = secretIds.size;
    const wouldDeleteTenantEncryptionKeys = tenantEncryptionKeyIds.size;
    const wouldDeleteUnrecoverableData =
      wouldDeleteSecrets + wouldDeleteTenantEncryptionKeys > 0;

    if (
      !dryRun &&
      wouldDeleteUnrecoverableData &&
      !options.confirmDeleteUnrecoverableData
    ) {
      throw new Error(
        'repairTenantSecretKeyDrift requires confirmDeleteUnrecoverableData: true before deleting encrypted secrets or tenant key rows.',
      );
    }

    let deletedSecrets = 0;
    let deletedTenantEncryptionKeys = 0;

    if (!dryRun) {
      deletedSecrets = await this.deleteRowsByIds(
        'secrets',
        tenantId,
        secretIds,
      );
      deletedTenantEncryptionKeys = await this.deleteRowsByIds(
        'tenant_encryption_keys',
        tenantId,
        tenantEncryptionKeyIds,
      );
      await this.auditSecretDriftRepairDeletes(
        tenantId,
        secretIds,
        secretNames,
      );
    }

    const after = dryRun
      ? before
      : await this.diagnoseTenantSecretKeyDrift(tenantId, options);

    return {
      tenantId,
      dryRun,
      issuesBefore: before.issues,
      remainingIssues: after.issues,
      wouldDeleteSecrets,
      wouldDeleteTenantEncryptionKeys,
      deletedSecrets,
      deletedTenantEncryptionKeys,
      secretNames: Array.from(secretNames.values()).sort(),
      tenantEncryptionKeyIds: Array.from(tenantEncryptionKeyIds).sort(),
    };
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

  private async listActiveSecretRowsForDiagnosis(
    tenantId: string,
    secretNames?: string[],
  ): Promise<SecretDiagnosisRow[]> {
    const params: unknown[] = [tenantId];
    let nameFilter = '';

    if (secretNames && secretNames.length > 0) {
      const placeholders = secretNames.map(() => '?').join(', ');
      nameFilter = ` AND name IN (${placeholders})`;
      params.push(...secretNames);
    }

    const result = await this.db.query(
      `
        SELECT id, name, encrypted_value, status, tenant_id
        FROM "secrets"
        WHERE tenant_id = ? AND status = 'active'${nameFilter}
        ORDER BY name ASC
      `,
      ...params,
    );

    return this.rowsFromResult<SecretDiagnosisRow>(result);
  }

  private async listTenantEncryptionKeyRows(
    tenantId: string,
  ): Promise<TenantEncryptionKeyRow[]> {
    const result = await this.db.query(
      `
        SELECT id, tenant_id, wrapped_key, amk_key_id, status, version,
          rotate_after, retired_at, created_at, updated_at
        FROM "tenant_encryption_keys"
        WHERE tenant_id = ?
        ORDER BY version DESC
      `,
      tenantId,
    );

    return this.rowsFromResult<TenantEncryptionKeyRow>(result);
  }

  private async listSmrtTenantKeysForDiagnosis(
    tenantId: string,
  ): Promise<TenantKey[]> {
    try {
      return await this.tenantKeys.listKeyVersions(tenantId);
    } catch {
      return [];
    }
  }

  private getConfiguredAmkForDiagnosis():
    | { usable: true; value: Buffer }
    | { usable: false; error: string; value?: undefined } {
    const keyHex = process.env[this.amkEnvVar];
    if (!keyHex) {
      return {
        usable: false,
        error: `Application Master Key not found in environment variable: ${this.amkEnvVar}`,
      };
    }

    try {
      return {
        usable: true,
        value: EnvelopeEncryption.parseHexKey(keyHex),
      };
    } catch (error) {
      return {
        usable: false,
        error: `Invalid AMK in ${this.amkEnvVar}: ${
          this.toError(error).message
        }`,
      };
    }
  }

  private checkWrappedKey(wrappedKey: string, amk: Buffer): WrappedKeyCheck {
    const fingerprint = this.getWrappedKeyFingerprint(wrappedKey);

    try {
      const parsed = EnvelopeEncryption.parseWrappedKey(wrappedKey);
      const dataKey = EnvelopeEncryption.unwrapKey(
        parsed.wrappedKey,
        parsed.iv,
        parsed.authTag,
        amk,
      );
      dataKey.fill(0);
      return { usable: true, fingerprint };
    } catch (error) {
      return {
        usable: false,
        fingerprint,
        error: this.toError(error).message,
      };
    }
  }

  private getWrappedKeyFingerprint(wrappedKey: string): string | undefined {
    try {
      return EnvelopeEncryption.parseWrappedKey(wrappedKey).wrappedKey;
    } catch {
      return undefined;
    }
  }

  private parseSecretEnvelopeForDiagnosis(
    secret: SecretDiagnosisRow,
    issues: SecretKeyDriftIssue[],
  ): EncryptedEnvelope | null {
    try {
      return JSON.parse(secret.encrypted_value) as EncryptedEnvelope;
    } catch (error) {
      issues.push({
        code: 'secret_envelope_invalid_json',
        severity: 'error',
        message: 'Secret encryptedValue is not valid EncryptedEnvelope JSON.',
        repairAction: 'delete-unrecoverable-secret',
        secretId: secret.id,
        secretName: secret.name,
        sourceTable: 'secrets',
        details: {
          error: this.toError(error).message,
        },
      });
      return null;
    }
  }

  private async deleteRowsByIds(
    tableName: 'secrets' | 'tenant_encryption_keys',
    tenantId: string,
    ids: Set<string>,
  ): Promise<number> {
    if (ids.size === 0) return 0;

    const idList = Array.from(ids);
    const placeholders = idList.map(() => '?').join(', ');
    const result = await this.db.query(
      `DELETE FROM "${tableName}" WHERE tenant_id = ? AND id IN (${placeholders})`,
      tenantId,
      ...idList,
    );

    return typeof result.rowCount === 'number'
      ? result.rowCount
      : idList.length;
  }

  private async auditSecretDriftRepairDeletes(
    tenantId: string,
    secretIds: Set<string>,
    secretNames: Map<string, string>,
  ): Promise<void> {
    if (secretIds.size === 0) return;

    const userId = this.getCurrentUserId();
    await withTenant({ tenantId }, async () => {
      for (const secretId of secretIds) {
        await this.audit(
          secretId,
          secretNames.get(secretId) ?? '',
          userId,
          'delete',
          'success',
          {
            action: 'repairTenantSecretKeyDrift',
            reason: 'unrecoverable-secret-key-drift',
          },
        );
      }
    });
  }

  private rowsFromResult<T>(result: unknown): T[] {
    if (Array.isArray(result)) return result as T[];
    if (
      result &&
      typeof result === 'object' &&
      Array.isArray((result as { rows?: unknown }).rows)
    ) {
      return (result as { rows: T[] }).rows;
    }
    return [];
  }

  private async classifyTenantKeyFailure(
    tenantId: string,
    secretName: string,
    error: unknown,
  ): Promise<Error> {
    const normalized = this.toError(error);
    if (!this.shouldClassifyTenantKeyFailure(normalized)) {
      return normalized;
    }

    try {
      const report = await this.diagnoseTenantSecretKeyDrift(tenantId, {
        secretNames: [secretName],
      });
      const errorCodes = report.issues
        .filter((issue) => issue.severity === 'error')
        .map((issue) => issue.code);

      if (errorCodes.length === 0) {
        return normalized;
      }

      return new SecretKeyDriftError(
        `Secret '${secretName}' for tenant '${tenantId}' failed because secret key drift was detected: ${[
          ...new Set(errorCodes),
        ].join(
          ', ',
        )}. Run diagnoseTenantSecretKeyDrift() for details and repairTenantSecretKeyDrift() for explicit cleanup of unrecoverable rows.`,
        tenantId,
        report,
        normalized,
      );
    } catch {
      return normalized;
    }
  }

  private shouldClassifyTenantKeyFailure(error: Error): boolean {
    const code = this.getSecretErrorCode(error);
    if (error instanceof AMKUnavailableError || code === 'AMK_UNAVAILABLE') {
      return false;
    }

    return (
      error instanceof TenantKeyMissingError ||
      error instanceof EncryptionError ||
      error instanceof DecryptionError ||
      code === 'TENANT_KEY_MISSING' ||
      code === 'ENCRYPTION_FAILED' ||
      code === 'DECRYPTION_FAILED'
    );
  }

  private getSecretErrorCode(error: Error): string | undefined {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }

  private toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }

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
