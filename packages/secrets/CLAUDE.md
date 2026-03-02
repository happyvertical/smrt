# @happyvertical/smrt-secrets

Envelope encryption for per-tenant secret storage with key rotation and audit logging.

## Encryption Architecture

```
Secret value → encrypted with TDEK (per-tenant Data Encryption Key)
  TDEK → wrapped with AMK (Application Master Key, from env SMRT_SECRET_MASTER_KEY)
```

## Models

- **Secret**: `encryptedValue` (JSON envelope), `category`, `status` (active/disabled/expired), `expiresAt`, `accessCount`, `lastAccessedAt`. **No API/MCP exposure** (security). CLI: list-only.
- **TenantKey**: per-tenant TDEK in wrapped form. Status: active/rotating/retired/compromised. **Not tenant-scoped itself** — it tracks keys FOR tenants.
- **SecretAuditLog**: action (create/read/update/delete/rotate_key/disable/enable), result (success/failure/denied), user/IP tracking. CLI: list-only.

## SecretService

| Method | Behavior |
|--------|----------|
| `store(name, value, options)` | Encrypt + save. Upsert if exists. Uses `context=tenantId` for per-tenant uniqueness. |
| `retrieve(name)` | Decrypt + audit + increment accessCount |
| `rotateKey()` | Create new TDEK, mark old as retired |
| `reencryptAll()` | Decrypt with old TDEK, re-encrypt with new — **must call separately after rotateKey()** |
| `disable(name)` / `enable(name)` | Toggle status |

## Gotchas

- **Key rotation doesn't auto-re-encrypt**: call `reencryptAll()` separately after `rotateKey()`
- **retrieve() increments accessCount**: every read is tracked
- **TenantKey NOT tenant-scoped**: it stores keys for tenants but isn't filtered by tenant context
- **Expired secrets filtered by default**: pass `includeExpired: true` to list them
- **TenantKeyCollection.cleanupRetiredKeys()**: hard-deletes after 90 days
- **Audit logging optional but default**: failures logged to console, not thrown
