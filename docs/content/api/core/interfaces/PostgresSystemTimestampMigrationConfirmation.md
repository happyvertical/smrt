# Interface: PostgresSystemTimestampMigrationConfirmation

Explicit confirmation required before SMRT reinterprets legacy framework-owned
PostgreSQL timestamps.

## Properties

### legacyTimezone

> **legacyTimezone**: `"UTC"`

Timezone used by every historical writer of timezone-naive system timestamps.
The built-in migration supports only audited UTC provenance.
