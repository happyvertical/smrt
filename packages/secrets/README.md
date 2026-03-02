# @happyvertical/smrt-secrets

Per-tenant secret management with envelope encryption for the SMRT framework. Uses a three-layer encryption scheme: Application Master Key (AMK) encrypts Tenant Data Encryption Keys (TDEK), which encrypt individual secrets.

## Installation

```bash
pnpm add @happyvertical/smrt-secrets
```

## Usage

```typescript
import { SecretService, Secret, SecretCollection, TenantKey } from '@happyvertical/smrt-secrets';

// Initialize the service
const service = new SecretService({
  db,
  applicationMasterKey: process.env.SMRT_AMK,
});

// Store a secret
await service.store({
  tenantId: 'tenant-123',
  name: 'OPENAI_API_KEY',
  value: 'sk-...',
});

// Retrieve a secret
const secret = await service.retrieve('tenant-123', 'OPENAI_API_KEY');
console.log(secret.value); // decrypted value

// List secrets (values not included)
const secrets = await service.list({ tenantId: 'tenant-123' });

// Rotate tenant encryption key
await service.rotateTenantKey('tenant-123');
```

## API

### Models

| Export | Description |
|--------|------------|
| `Secret` | Encrypted secret record |
| `SecretAuditLog` | Audit trail for secret operations |
| `TenantKey` | Per-tenant data encryption key |

### Collections

`SecretCollection`, `SecretAuditLogCollection`, `TenantKeyCollection`

### Services

| Export | Description |
|--------|------------|
| `SecretService` | High-level API for storing, retrieving, and rotating secrets |

### Functions

| Export | Description |
|--------|------------|
| `createAuditEntry` | Create an audit log entry for a secret operation |

### Error Classes

`SecretError`, `AMKUnavailableError`, `DecryptionError`, `EncryptionError`, `InvalidKeyFormatError`, `KeyNotFoundError`, `KeyRotationError`, `StoreNotInitializedError`, `TenantKeyMissingError`

### Key Types

`SecretServiceOptions`, `StoreSecretOptions`, `RetrievedSecret`, `ListSecretsOptions`, `SecretStatus`, `SecretAuditAction`, `TenantKeyStatus`, `ApplicationMasterKey`, `EncryptedEnvelope`, `TenantDataEncryptionKey`

## Dependencies

- `@happyvertical/smrt-core` — ORM and code generation
- `@happyvertical/smrt-tenancy` — multi-tenant scoping
