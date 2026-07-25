/**
 * Fail-closed confirmation shared by PostgreSQL schema preview and migration.
 *
 * A `timestamp without time zone` value cannot establish its own original
 * instant. Callers must therefore make the same explicit UTC provenance
 * confirmation whether they are previewing or applying the conversion.
 */
export function resolvePostgresTimestampMigration(
  legacyTimezone: string | undefined,
): { legacyTimezone: 'UTC' } | undefined {
  if (legacyTimezone === undefined) {
    return undefined;
  }

  if (legacyTimezone !== 'UTC') {
    throw new Error(
      '--postgres-timestamp-legacy-timezone must be exactly UTC; refusing to infer the offset of legacy PostgreSQL timestamps',
    );
  }

  return { legacyTimezone: 'UTC' };
}
