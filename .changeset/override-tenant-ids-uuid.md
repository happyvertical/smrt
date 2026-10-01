---
'@happyvertical/smrt-prompts': minor
'@happyvertical/smrt-playbooks': minor
'@happyvertical/smrt-languages': minor
'@happyvertical/smrt-secrets': minor
---

`PromptOverride`, `PlaybookOverride`, `LanguageOverride` and `TenantKey` declare
their `tenantId` as UUID, so it compares with every other `tenant_id` column.
They stay deliberately not tenant-scoped. SQLite and DuckDB keep storing text.
**On PostgreSQL run `smrt db:migrate-uuid`** to converge the existing text
columns to native `uuid` (`db:status` reports them until then); a non-uuid
value in those columns blocks the conversion and is reported with a sample.

`@happyvertical/smrt-secrets`: an audit actor that is not a uuid (an email login
identity, a service name) no longer fails the audit insert, and with it the
audited operation: `secret_audit_logs.user_id` stores NULL and the raw actor is
kept as `details.actorId`.
