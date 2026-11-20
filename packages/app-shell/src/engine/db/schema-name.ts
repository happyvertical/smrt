// Pure checks of what a host configures (no database import), so the host
// thread can refuse a bad config before it starts a worker.

import { createHash } from 'node:crypto';
import { EngineError } from '../errors.ts';

/** Longest part of an app's schema a side name keeps (63 - `__` - tag - 16). */
const KEEP = 44;
const SIDE = /^[a-z_][a-z0-9_]{0,43}__[dron][a-z0-9]{16}$/;
const hashOf = (base: string) =>
  createHash('sha256').update(base).digest('hex').slice(0, 8);

/**
 * The name of a copy of `base` (a draft `d`, rehearsal `r`, aside `o`,
 * restore `n`): `<first 44 of base>__<tag><8 hex of sha256(full base)><8 random>`,
 * at most 63 bytes. Two apps that share their first 44 characters still get
 * different names. The name is only a first filter: ownership is the schema
 * comment, checked before anything is dropped (`sideOwnerComment`).
 */
export function sideName(
  base: string,
  tag: 'd' | 'r' | 'o' | 'n',
  rand: string,
) {
  return `${base.slice(0, KEEP)}__${tag}${hashOf(base)}${rand}`;
}

/** What the copy's `COMMENT ON SCHEMA` says: whose it is, the FULL name of the app's schema. */
export const sideOwnerComment = (base: string) => `smrt-side:${base}`;

/**
 * True for a name `sideName` makes, optionally only of `base` (prefix and hash
 * of the full name) and only of the given tags.
 */
export function isSideSchema(name: unknown, base?: string, tags = 'dron') {
  if (typeof name !== 'string' || !SIDE.test(name)) return false;
  if (!tags.includes(name.charAt(name.length - 17))) return false;
  return (
    base === undefined ||
    (name.startsWith(`${base.slice(0, KEEP)}__`) &&
      name.slice(-16, -8) === hashOf(base))
  );
}

/** A schema name the host may give an app: a plain lower-case identifier, never a copy's name. */
export function assertAppSchema(schema: unknown): string {
  assertSchemaName(schema);
  if (SIDE.test(schema as string))
    throw new EngineError(
      `'${schema}' looks like a draft, rehearsal or restore schema the engine makes; an app's own schema cannot be named like one`,
      'refused',
    );
  return schema as string;
}

/** Any schema the engine opens: an app's, or a copy's (a draft's own). */
export function assertSchemaName(schema: unknown): string {
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
