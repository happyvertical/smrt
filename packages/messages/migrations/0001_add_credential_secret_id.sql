-- migrations/0001_add_credential_secret_id.sql
-- @id: 0001_add_credential_secret_id
-- @description: Add credential_secret_id column for secrets integration

-- @up
ALTER TABLE email_accounts ADD COLUMN credential_secret_id TEXT;
CREATE INDEX IF NOT EXISTS idx_email_accounts_credential_secret_id ON email_accounts(credential_secret_id);

-- @down
DROP INDEX IF EXISTS idx_email_accounts_credential_secret_id;
ALTER TABLE email_accounts DROP COLUMN credential_secret_id;
