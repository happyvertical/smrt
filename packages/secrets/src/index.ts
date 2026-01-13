/**
 * @happyvertical/smrt-secrets
 *
 * Per-tenant secret management with envelope encryption for SMRT.
 *
 * @example
 * ```typescript
 * import { SecretService } from '@happyvertical/smrt-secrets';
 * import { withTenant } from '@happyvertical/smrt-tenancy';
 * import { getDatabase } from '@happyvertical/sql';
 *
 * // Create database connection
 * const db = await getDatabase({ type: 'sqlite', url: 'app.db' });
 *
 * // Create secret service
 * const service = await SecretService.create({ db });
 *
 * // Use within tenant context
 * await withTenant({ tenantId: 'tenant-123' }, async () => {
 *   // Store a secret
 *   await service.store('api-key', 'sk_live_xxx', {
 *     category: 'stripe',
 *     description: 'Production API key'
 *   });
 *
 *   // Retrieve the secret
 *   const { value } = await service.retrieve('api-key');
 *   console.log(value); // 'sk_live_xxx'
 *
 *   // List secrets (names only)
 *   const secrets = await service.list();
 *
 *   // Rotate encryption key
 *   await service.rotateKey();
 *
 *   // Delete a secret
 *   await service.delete('api-key');
 * });
 * ```
 *
 * @packageDocumentation
 */

// Re-export SDK types for convenience
export type {
  ApplicationMasterKey,
  EncryptedEnvelope,
  SecretStore,
  TenantDataEncryptionKey,
} from '@happyvertical/secrets';
// Re-export SDK errors
export {
  AMKUnavailableError,
  DecryptionError,
  EncryptionError,
  InvalidKeyFormatError,
  KeyNotFoundError,
  KeyRotationError,
  SecretError,
  StoreNotInitializedError,
  TenantKeyMissingError,
} from '@happyvertical/secrets';
export {
  type ListAuditLogsOptions,
  SecretAuditLogCollection,
} from './collections/SecretAuditLogCollection.js';

// Collections
export {
  type ListSecretsOptions,
  SecretCollection,
} from './collections/SecretCollection.js';

export { TenantKeyCollection } from './collections/TenantKeyCollection.js';
// Models
export {
  Secret,
  type SecretStatus,
} from './models/Secret.js';
export {
  createAuditEntry,
  type SecretAuditAction,
  SecretAuditLog,
  type SecretAuditResult,
} from './models/SecretAuditLog.js';
export {
  TenantKey,
  type TenantKeyStatus,
} from './models/TenantKey.js';
// Service
export {
  type RetrievedSecret,
  SecretService,
  type SecretServiceOptions,
  type StoreSecretOptions,
} from './services/SecretService.js';

/** @internal */
export const PACKAGE_VERSION_INITIALIZED = true;
