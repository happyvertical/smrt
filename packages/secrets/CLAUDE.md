# @happyvertical/smrt-secrets

Encrypted secret storage with envelope encryption. Manages credentials, API keys, and sensitive data with per-tenant data encryption keys (TDEKs) wrapped by an Application Master Key (AMK).

## Architecture

```
src/
  index.ts              # Export barrel
  models/
    Secret.ts           # Encrypted secret record
    TenantKey.ts        # Per-tenant data encryption key
  collections/
    SecretCollection.ts     # Query by category, status, expiry
    TenantKeyCollection.ts  # Key lifecycle management
  types/                # SecretStatus, encryption types
```

## Key Models

- `Secret` — Encrypted secret: category, encrypted value, key version, expiry, rotation tracking
- `TenantKey` — Per-tenant TDEK: wrappedKey, amkKeyId, status, version

## Key Patterns

- **Envelope encryption**: Secrets encrypted with TDEK, TDEK wrapped with AMK
- **Key lifecycle**: active → rotating → retired → compromised
- **TenantKey is NOT tenant-scoped**: It tracks keys FOR tenants, not owned BY tenants
- **Secret categories**: Group secrets by type (api-key, credential, token, etc.)
- **Rotation support**: Key versioning enables zero-downtime key rotation
- **Expiry tracking**: Secrets can have expiration dates

## Dependencies

- `@happyvertical/smrt-core`
- `@happyvertical/encryption` (optional peer dependency)
