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

## Known exceptions to monorepo standards

Per `docs/content/standards.md §7`, tenant-aware models should normally apply
`@TenantScoped({ mode: 'optional' })` from `@happyvertical/smrt-tenancy`. The three
models in this package deviate intentionally; each `@smrt(...)` block carries an
inline comment pointing back to this section.

- **`Secret` (`src/models/Secret.ts`)** — uses the inline `tenantScoped: true` form
  on `@smrt()` instead of the `@TenantScoped` decorator. `SecretService.store()`
  performs manual scoping by populating `context = tenantId` on each row, so the
  `(slug, context)` upsert key from the base `SmrtObject` is what isolates secret
  names per tenant. Switching to the decorator without rethinking the upsert key
  would surface false-positive name collisions across tenants.
- **`TenantKey` (`src/models/TenantKey.ts`)** — deliberately NOT tenant-scoped at
  all. The row carries a `tenantId` column because each TDEK belongs to a tenant,
  but key-rotation tooling, AMK rewrap jobs, and super-admin audits must query
  across tenants; the tenancy interceptor would silently filter rows those flows
  rely on.
- **`SecretAuditLog` (`src/models/SecretAuditLog.ts`)** — uses the inline
  `tenantScoped: true` form rather than the decorator. Audit reads run in mixed
  contexts (tenant-scoped reports vs. super-admin compliance review); pairing the
  boolean form with explicit `withSuperAdminBypass()` at compliance call sites
  keeps cross-tenant audit queries explicit instead of magical.
