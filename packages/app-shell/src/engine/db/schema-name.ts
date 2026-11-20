// Pure checks of what a host configures (no database import), so the host
// thread can refuse a bad config before it starts a worker.

import { EngineError } from '../errors.ts';

/** What a copy's schema name starts with: the app's schema (cut to leave room for the tag) and `__`. */
export const sidePrefix = (base: string) => `${base.slice(0, 52)}__`;
const SIDE = /^[a-z_][a-z0-9_]{0,50}__[dron][a-z0-9]{8}$/;

/**
 * True for a name `sideSchemaName` makes (a draft `d`, rehearsal `r`, aside
 * `o` or restore `n`), optionally only of `base`'s and only the given tags.
 * Everything the engine drops or swaps by name is checked against this first:
 * a journal or marker that names anything else is not trusted.
 */
export function isSideSchema(name: unknown, base?: string, tags = 'dron') {
  if (typeof name !== 'string' || !SIDE.test(name)) return false;
  if (!tags.includes(name.charAt(name.length - 9))) return false;
  return base === undefined || name.startsWith(sidePrefix(base));
}

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
