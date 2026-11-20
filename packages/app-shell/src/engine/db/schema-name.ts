// Pure checks of what a host configures (no database import), so the host
// thread can refuse a bad config before it starts a worker.

import { EngineError } from '../errors.ts';

/** A schema name the host may give an app: lower-case identifier, never `public` or a system schema. */
export function assertAppSchema(schema: unknown): string {
  if (typeof schema !== 'string' || !schema)
    throw new EngineError(
      'a PostgreSQL app needs a schema (one schema per app); none was configured',
      'refused',
    );
  if (
    !/^[a-z_][a-z0-9_]{0,62}$/.test(schema) ||
    schema === 'public' ||
    schema.startsWith('pg_') ||
    schema === 'information_schema'
  )
    throw new EngineError(
      `'${schema}' is not a usable app schema (a lower-case identifier that is not public or a system schema)`,
      'refused',
    );
  return schema;
}
