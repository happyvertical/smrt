# Function: migratePostgresSystemTimestamps()

> **migratePostgresSystemTimestamps**(`db`, `confirmation`, `typeHint?`): `Promise`\<`void`\>

Atomically converts legacy framework-owned `_smrt_*` PostgreSQL timestamps to
`TIMESTAMPTZ` and upgrades the change-feed helper ABI under the system-table
advisory lock. The operation refuses to run outside a UTC database session and
requires an explicit audit confirmation.

## Parameters

### db

`DatabaseInterface`

### confirmation

[`PostgresSystemTimestampMigrationConfirmation`](../interfaces/PostgresSystemTimestampMigrationConfirmation.md)

### typeHint?

`string`

## Returns

`Promise`\<`void`\>
