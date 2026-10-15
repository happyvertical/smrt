# Commerce money migration commands

Run the normal schema migration before these data commands. The Commerce data
migration never creates tables or columns at runtime.

These commands are for tenants that already hold legacy Invoice or Contract
rows. A tenant with no documents starts on money v2 when its settings are first
created, or through `ensureCommerceTenant()` (#4009); it has nothing to
migrate and the claim refuses it.

1. Generate review artifacts without changing the database:

   ```sh
   smrt db:preflight-commerce-money \
     --tenant-id <tenant-id> \
     --json-path ./commerce-money.json \
     --csv-path ./commerce-money.csv
   ```

   Omit `--tenant-id` only for a system-wide read-only report. The two output
   paths are optional, but must be supplied together. Review every reason code,
   repair `UNRECONCILED` documents before continuing, and assign the required
   fallback tax accounts.

2. Migrate one tenant after review:

   ```sh
   smrt db:migrate-commerce-money --tenant-id <tenant-id>
   ```

   The command prints its migration owner UUID before it claims the tenant.
   Preserve that value. If the process is interrupted, repeat the command with
   `--migration-id <uuid>`; a different owner is refused. Add
   `--accept-draft-changes` only after approving the draft deltas from preflight.

3. Roll back during the supported rollback window:

   ```sh
   smrt db:rollback-commerce-money \
     --tenant-id <tenant-id> \
     --migration-id <uuid>
   ```

   Rollback restores the durable pre-images only when every current document
   still matches its recorded post-image. Any later document, line, payment,
   credit, or accounting-sync change blocks the whole rollback before a restore.

All commands use the configured database and redact credentials from failures.
The migrate and rollback commands share the same tenant runtime barrier as
Commerce reads and writes; do not alter the tenant marker directly.

The data invariants and header-identity exception are documented in
`@happyvertical/smrt-commerce/agents/line-amount-migration.md`.
