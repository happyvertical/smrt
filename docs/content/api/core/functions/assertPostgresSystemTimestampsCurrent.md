# Function: assertPostgresSystemTimestampsCurrent()

> **assertPostgresSystemTimestampsCurrent**(`db`, `typeHint?`): `Promise`\<`void`\>

Fails closed when framework-owned PostgreSQL tables still contain legacy
timezone-naive timestamps. Bootstrap calls this before recording the current
system schema version.

## Parameters

### db

`DatabaseInterface`

### typeHint?

`string`

## Returns

`Promise`\<`void`\>
