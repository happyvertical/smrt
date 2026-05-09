# EmailAccount Secrets Migration Guide

The `EmailAccount` model now supports secure credential storage via `@happyvertical/smrt-secrets`.

## Overview

**What changed:**
- Added `credentialSecretId` field to store reference to encrypted credentials
- `settings` field is now **DEPRECATED** (still supported for backward compatibility)
- New methods: `setCredentials()`, `getCredentials()`, `migrateToSecrets()`
- `createClient()` automatically retrieves credentials from secrets if available

**Benefits:**
- ✅ Envelope encryption (per-tenant keys)
- ✅ Audit trail (who accessed what, when)
- ✅ Key rotation support
- ✅ Never store credentials in plain text

## For New Accounts

**Recommended approach** (using secrets):

```typescript
import { EmailAccount } from '@happyvertical/smrt-messages';

const account = new EmailAccount({
  name: 'Support Inbox',
  email: 'support@example.com',
  providerType: 'imap',
  db,
});

await account.save();

// Store credentials securely
await account.setCredentials({
  host: 'imap.gmail.com',
  port: 993,
  secure: true,
  auth: {
    user: 'support@example.com',
    pass: process.env.EMAIL_PASSWORD,
  },
});

// Create client (automatically retrieves from secrets)
const client = await account.createClient();
```

## Migrating Existing Accounts

### Option 1: Automatic Migration

```typescript
// Migrate all accounts
const accounts = await EmailAccount.list();

for (const account of accounts) {
  await account.migrateToSecrets();
  console.log(`Migrated account: ${account.email}`);
}
```

### Option 2: Manual Migration

```typescript
const account = await EmailAccount.get(accountId);

// Get existing settings
const settings = account.getSettings();

// Store in secrets
await account.setCredentials(settings, {
  description: `IMAP credentials for ${account.name}`,
  category: 'email',
});

// Optional: Clear plain-text settings
account.settings = '';
await account.save();
```

## Backward Compatibility

The `settings` field is **still supported** for backward compatibility:

```typescript
// Old approach (still works but DEPRECATED)
const account = new EmailAccount({
  name: 'Support Inbox',
  email: 'support@example.com',
  providerType: 'imap',
  settings: JSON.stringify({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: 'support@example.com', pass: 'password' },
  }),
  db,
});

// createClient() will use settings if credentialSecretId is not set
const client = await account.createClient();
```

## API Reference

### `setCredentials(credentials, options?)`

Store credentials securely using smrt-secrets.

```typescript
await account.setCredentials(
  {
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: {
      user: 'support@example.com',
      pass: process.env.EMAIL_PASSWORD,
    },
  },
  {
    description: 'IMAP credentials for support inbox',
    category: 'email',
  }
);
```

### `getCredentials()`

Retrieve stored credentials (for debugging/migration).

⚠️ **WARNING**: This exposes credentials in plain text.

```typescript
const credentials = await account.getCredentials();
console.log(credentials);
// {
//   host: 'imap.gmail.com',
//   port: 993,
//   secure: true,
//   auth: { user: 'support@example.com', pass: '...' }
// }
```

### `migrateToSecrets()`

Migrate from plain-text `settings` to secrets.

```typescript
await account.migrateToSecrets();
```

### `createClient()`

Create email client (automatically retrieves credentials from secrets).

```typescript
const client = await account.createClient();
await client.connect();
```

## CLI Commands

```bash
# Create account with secrets
smrt email-account:create \
  --name "Support Inbox" \
  --email "support@example.com" \
  --provider imap

# Set credentials interactively (prompts for password)
smrt email-account:set-credentials <accountId>

# Migrate all accounts to secrets
smrt email-account:migrate-all

# Test connection
smrt email-account:test <accountId>
```

## Security Best Practices

1. **Always use secrets for new accounts**
   ```typescript
   await account.setCredentials(credentials);
   ```

2. **Never log credentials**
   ```typescript
   // ❌ BAD
   console.log(await account.getCredentials());

   // ✅ GOOD
   const client = await account.createClient();
   ```

3. **Use environment variables**
   ```typescript
   await account.setCredentials({
     host: process.env.IMAP_HOST,
     auth: {
       user: process.env.IMAP_USER,
       pass: process.env.IMAP_PASSWORD,
     },
   });
   ```

4. **Rotate credentials regularly**
   ```typescript
   // Update credentials (automatically updates secret)
   await account.setCredentials(newCredentials);
   ```

5. **Clear plain-text after migration**
   ```typescript
   await account.migrateToSecrets();
   account.settings = '';
   await account.save();
   ```

## Audit Trail

All secret access is logged:

```typescript
import { SecretAuditLogCollection } from '@happyvertical/smrt-secrets';

const auditLogs = await SecretAuditLogCollection.create({ db });
const logs = await auditLogs.list({
  where: { secretId: account.credentialSecretId },
  orderBy: 'createdAt DESC',
  limit: 10,
});

logs.forEach((log) => {
  console.log(`${log.action} by ${log.userId} at ${log.createdAt}`);
});
```

## Troubleshooting

### Error: "Secret not found"

The `credentialSecretId` references a secret that doesn't exist.

**Solution:**
```typescript
// Re-create credentials
await account.setCredentials(credentials);
```

### Error: "Access denied"

Tenant context is required to access secrets.

**Solution:**
```typescript
import { withTenant } from '@happyvertical/smrt-tenancy';

await withTenant({ tenantId: 'tenant-123' }, async () => {
  const client = await account.createClient();
});
```

### Account created before secrets integration

Accounts created before secrets integration use the `settings` field.

**Solution:**
```typescript
await account.migrateToSecrets();
```

## Environment Setup

Ensure `SMRT_AMK` environment variable is set:

```bash
# Generate AMK (64 hex characters)
export SMRT_AMK=$(openssl rand -hex 32)

# Or use existing AMK
export SMRT_AMK="your-64-char-hex-key"
```

## Database Schema Changes

The migration adds one new field:

```sql
ALTER TABLE email_accounts ADD COLUMN credential_secret_id TEXT;
```

The `settings` field remains for backward compatibility but should not be used for new accounts.
