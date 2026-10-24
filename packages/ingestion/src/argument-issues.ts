import Ajv, { type ErrorObject } from 'ajv';
import type { HandlerArgumentIssue } from './review-dto.js';

type SchemaNode = Record<string, unknown>;
/** Every object node an instance at this position may be validated against. */
function schemaNodes(node: unknown): SchemaNode[] {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return [];
  const current = node as SchemaNode;
  const nested = ['oneOf', 'anyOf', 'allOf'].flatMap((keyword) =>
    Array.isArray(current[keyword])
      ? (current[keyword] as unknown[]).flatMap(schemaNodes)
      : [],
  );
  return [current, ...nested];
}
/** RFC 6901 segment escaping: `~` becomes `~0`, then `/` becomes `~1`. */
function escapeSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}
/**
 * Keep only path segments the schema itself names: indexes into an actual
 * array in the instance, and keys declared under `properties`. Anything else
 * (keys under `additionalProperties`/`patternProperties`, numeric keys of an
 * object, or an unknown key) is data and becomes `?`. `/` is the whole
 * instance. With `escaped`, kept segments are RFC 6901-escaped (`~0`, `~1`);
 * without it (the `ProposalValidationError` reason format) they are not.
 */
export function schemaOwnedPath(
  instancePath: string,
  schema: unknown,
  instance?: unknown,
  escaped = false,
): string {
  if (!instancePath) return '/';
  let nodes = schemaNodes(schema);
  let value: unknown = instance;
  const segments = instancePath.split('/').slice(1);
  const kept: string[] = [];
  for (const raw of segments) {
    const segment = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    // An index is schema-owned only when the parent value really is an array;
    // the schema alone cannot tell an index from a numeric data key when a
    // union allows both shapes.
    if (/^\d+$/.test(segment) && Array.isArray(value)) {
      kept.push(segment);
      value = value[Number(segment)];
      nodes = nodes.flatMap((node) =>
        node.type === 'array' || node.items !== undefined
          ? schemaNodes(node.items)
          : [],
      );
      continue;
    }
    value =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)[segment]
        : undefined;
    const owners = nodes.filter((node) => {
      const properties = node.properties;
      return (
        !!properties &&
        typeof properties === 'object' &&
        Object.hasOwn(properties as object, segment)
      );
    });
    if (owners.length) {
      kept.push(segment);
      nodes = owners.flatMap((node) =>
        schemaNodes((node.properties as SchemaNode)[segment]),
      );
    } else {
      kept.push('?');
      nodes = nodes.flatMap((node) =>
        typeof node.additionalProperties === 'object'
          ? schemaNodes(node.additionalProperties)
          : [],
      );
    }
  }
  return `/${kept.map((segment) => (escaped && segment !== '?' ? escapeSegment(segment) : segment)).join('/')}`;
}

/** Most field details one `HandlerArgumentsInvalidError` carries. */
export const HANDLER_ARGUMENT_ISSUE_LIMIT = 20;
/** Longest issue path; a deeper path keeps its prefix. */
export const HANDLER_ARGUMENT_PATH_LIMIT = 160;
/** Ajv errors examined per refusal, duplicates included. */
const ERRORS_EXAMINED = 200;
const KEYWORD = /^[A-Za-z$][A-Za-z0-9_$-]{0,63}$/;

/**
 * Value-free field details for an argument-schema refusal: RFC 6901-escaped
 * schema-owned paths (see `schemaOwnedPath`) and the failing schema keyword. A `required` failure
 * names the schema-declared missing property; no other Ajv `params`, message,
 * or instance value is ever read into the result. Bounded and frozen.
 */
export function handlerArgumentIssues(
  errors: readonly ErrorObject[] | null | undefined,
  schema: unknown,
  instance: unknown,
): readonly HandlerArgumentIssue[] {
  const issues: HandlerArgumentIssue[] = [];
  const seen = new Set<string>();
  const paths = new Map<string, string>();
  const all = errors ?? [];
  for (
    let index = 0;
    index < all.length &&
    index < ERRORS_EXAMINED &&
    issues.length < HANDLER_ARGUMENT_ISSUE_LIMIT;
    index++
  ) {
    const error = all[index];
    let path = paths.get(error.instancePath);
    if (path === undefined) {
      path = schemaOwnedPath(error.instancePath, schema, instance, true);
      paths.set(error.instancePath, path);
    }
    const missing = (error.params as Record<string, unknown>).missingProperty;
    if (error.keyword === 'required' && typeof missing === 'string')
      // `required` lists schema-authored names only, never instance keys.
      path = `${path === '/' ? '' : path}/${escapeSegment(missing)}`;
    if (path.length > HANDLER_ARGUMENT_PATH_LIMIT)
      // Never leave half of a `~0`/`~1` escape at the cut.
      path = path.slice(0, HANDLER_ARGUMENT_PATH_LIMIT).replace(/~$/, '');
    const keyword = KEYWORD.test(error.keyword) ? error.keyword : undefined;
    const key = `${path}\u0000${keyword ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push(Object.freeze(keyword ? { path, keyword } : { path }));
  }
  return Object.freeze(issues);
}

/**
 * Re-validate refused arguments with every error collected, only to describe
 * the refusal. The authoritative accept/refuse decision is the caller's own
 * validator; this never changes it.
 */
export function describeArgumentRefusal(
  schema: Record<string, unknown>,
  value: unknown,
): readonly HandlerArgumentIssue[] {
  try {
    const check = new Ajv({
      strict: true,
      allErrors: true,
      validateFormats: false,
    }).compile(schema);
    return check(value)
      ? Object.freeze([])
      : handlerArgumentIssues(check.errors, schema, value);
  } catch {
    return Object.freeze([]);
  }
}
