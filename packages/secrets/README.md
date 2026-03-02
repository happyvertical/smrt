# @happyvertical/smrt-secrets

Per-tenant secret management with envelope encryption for the SMRT framework. Uses a three-layer encryption chain: Application Master Key (AMK) wraps per-tenant Data Encryption Keys (TDEK), which encrypt individual secret values.

## Installation

```bash
pnpm add @happyvertical/smrt-secrets
```

Requires the `SMRT_SECRET_MASTER_KEY` environment variable (64 hex characters) as the AMK.

## Usage

```typescript
import { SecretService } from '@happyvertical/smrt-secrets';
import { withTenant } from '@happyvertical/smrt-tenancy';

// Create the service (reads AMK from env by default)
const service = await SecretService.create({ db });

await withTenant({ tenantId: 'tenant-123' }, async () => {
  // Store a secret (upserts if name already exists)
  await service.store('stripe-api-key', 'sk_live_xxx', {
    category: 'api-keys',
    description: 'Stripe production key',
    expiresAt: new Date('2027-01-01'),
  });

  // Retrieve and decrypt
  const { value, accessCount } = await service.retrieve('stripe-api-key');

  // List secret names (values never included)
  const secrets = await service.list({ category: 'api-keys' });

  // Disable/enable without deleting
  await service.disable('stripe-api-key');
  await service.enable('stripe-api-key');

  // Rotate the tenant's encryption key
  await service.rotateKey();
  // Re-encrypt all secrets with the new key (separate step)
  await service.reencryptAll();

  // Query audit logs
  const logs = await service.getAuditLogs({ secretName: 'stripe-api-key' });

  // Hard delete
  await service.delete('stripe-api-key');
});
```

### Encryption chain

```
AMK (env var, 256-bit)
  └─ wraps TDEK (per-tenant, auto-generated)
       └─ encrypts secret value (stored as JSON envelope)
```

The AMK is loaded from `SMRT_SECRET_MASTER_KEY` (configurable via `amkEnvVar` option). Each tenant gets its own TDEK on first secret storage. TDEKs are stored in wrapped form -- they can only be unwrapped using the AMK. Secret values are encrypted by the unwrapped TDEK and persisted as `EncryptedEnvelope` JSON.

### Key rotation

`rotateKey()` creates a new TDEK version and retires the old one. Existing secrets remain readable because retired keys are kept for decryption. Call `reencryptAll()` separately after rotation to re-encrypt all secrets with the new key. The method returns `{ success, failed }` counts.

TenantKey statuses: `active` (current encryption key), `rotating` (transitional), `retired` (kept for decryption), `compromised` (should not be used).

### Audit logging

Every secret operation (create, read, update, delete, rotate_key, disable, enable) is logged to `SecretAuditLog` with user ID, action, result (success/failure/denied), and optional IP/user-agent. Audit logging is enabled by default; failures are logged to console rather than thrown so they do not block secret operations.

### Security model

The `Secret` and `TenantKey` models have no API or MCP exposure to prevent accidental leakage. CLI access is limited to listing names. The `TenantKey` model is deliberately not tenant-scoped -- it tracks keys FOR tenants rather than being owned BY them.

## API

### Models

| Export | Description |
|--------|------------|
| `Secret` | Encrypted secret record with status, expiration, and access tracking |
| `SecretAuditLog` | Immutable audit trail for all secret operations |
| `TenantKey` | Per-tenant data encryption key in wrapped form |

### Collections

| Export | Description |
|--------|------------|
| `SecretCollection` | Secret queries with tenant filtering and category support |
| `SecretAuditLogCollection` | Audit log queries with filtering and pagination |
| `TenantKeyCollection` | Key management including retired key cleanup |

### Services

| Export | Description |
|--------|------------|
| `SecretService` | High-level API: store, retrieve, rotate, delete, audit |

### Functions

| Export | Description |
|--------|------------|
| `createAuditEntry` | Build an audit log entry for a secret operation |

### Error Classes (re-exported from `@happyvertical/secrets`)

`SecretError`, `AMKUnavailableError`, `DecryptionError`, `EncryptionError`, `InvalidKeyFormatError`, `KeyNotFoundError`, `KeyRotationError`, `StoreNotInitializedError`, `TenantKeyMissingError`

### Key Types

`SecretServiceOptions`, `StoreSecretOptions`, `RetrievedSecret`, `ListSecretsOptions`, `ListAuditLogsOptions`, `SecretStatus`, `SecretAuditAction`, `SecretAuditResult`, `TenantKeyStatus`, `ApplicationMasterKey`, `EncryptedEnvelope`, `TenantDataEncryptionKey`, `SecretStore`

## Dependencies

- `@happyvertical/smrt-core` -- ORM and code generation
- `@happyvertical/smrt-tenancy` -- tenant context for scoped operations
- `@happyvertical/secrets` -- envelope encryption primitives
- `@happyvertical/sql` -- database interface
- `@happyvertical/utils` -- shared utilities
