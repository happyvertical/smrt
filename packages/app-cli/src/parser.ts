/**
 * JSONSchema → argv flag parser.
 *
 * The CLI surfaces each command's parameters as `--flag` arguments. v0.1
 * supports a deliberate subset of JSONSchema; anything beyond that falls
 * back to a positional `'<json>'` escape hatch.
 *
 * Supported (per top-level property):
 *   - `type: "string" | "integer" | "number" | "boolean"`
 *   - `type: "string", enum: [...]`
 *   - `type: "array", items: { type: "string" | "integer" | "number" }`
 *   - `nullable: true` / `type: ["string", "null"]`
 *     (omitted = absent from body, NOT null)
 *   - `required: [...]` (enforced)
 *   - `default: ...`
 *   - `additionalProperties: true | false`
 *
 * Not supported (falls back to positional JSON payload):
 *   - Nested objects
 *   - `oneOf` / `anyOf` / `allOf`
 *   - Arrays of objects
 *   - `$ref`
 *
 * @packageDocumentation
 */

export interface ParsedArgs {
  /** Body to send (JSON serialised, for POST/PUT/PATCH). May be empty. */
  body: Record<string, unknown>;
  /** Query string parameters (for GET). May be empty. */
  query: Record<string, string | string[]>;
  /** True when the user passed a positional `'<json>'` payload — body is that. */
  fromPositional: boolean;
}

export interface ParserOptions {
  /** Force-treat schema as unsupported (caller already detected unsupportedness). */
  positionalOnly?: boolean;
}

export type SchemaSupportStatus =
  | { kind: 'ok' }
  | { kind: 'unsupported'; reason: string }
  | { kind: 'missing' };

/**
 * Classify a JSONSchema. The CLI uses this to decide between rich flag
 * parsing and the positional JSON escape hatch.
 */
export function classifySchema(
  schema: Record<string, unknown> | undefined,
): SchemaSupportStatus {
  if (!schema || Object.keys(schema).length === 0) return { kind: 'missing' };
  if (schema.type !== 'object') {
    return { kind: 'unsupported', reason: 'schema root is not an object' };
  }
  if (schema.oneOf || schema.anyOf || schema.allOf || schema.$ref) {
    return { kind: 'unsupported', reason: 'oneOf/anyOf/allOf/$ref' };
  }

  const props = (schema.properties ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  for (const [name, prop] of Object.entries(props)) {
    const status = classifyProperty(prop);
    if (status.kind === 'unsupported') {
      return {
        kind: 'unsupported',
        reason: `${name}: ${status.reason}`,
      };
    }
  }
  return { kind: 'ok' };
}

function classifyProperty(prop: Record<string, unknown>): SchemaSupportStatus {
  const t = normaliseType(prop);
  if (!t) return { kind: 'unsupported', reason: 'no type' };
  if (prop.oneOf || prop.anyOf || prop.allOf || prop.$ref) {
    return { kind: 'unsupported', reason: 'oneOf/anyOf/allOf/$ref' };
  }
  if (t.primary === 'object') {
    return { kind: 'unsupported', reason: 'nested object' };
  }
  if (t.primary === 'array') {
    const items = prop.items as Record<string, unknown> | undefined;
    const itemsType = items?.type;
    if (
      itemsType !== 'string' &&
      itemsType !== 'integer' &&
      itemsType !== 'number'
    ) {
      return { kind: 'unsupported', reason: 'array of non-primitives' };
    }
  }
  return { kind: 'ok' };
}

interface NormalisedType {
  primary: 'string' | 'integer' | 'number' | 'boolean' | 'array' | 'object';
  nullable: boolean;
}

function normaliseType(
  prop: Record<string, unknown>,
): NormalisedType | undefined {
  const raw = prop.type;
  if (typeof raw === 'string') {
    return {
      primary: raw as NormalisedType['primary'],
      nullable: Boolean(prop.nullable),
    };
  }
  if (Array.isArray(raw)) {
    const nullable = raw.includes('null');
    const nonNull = raw.find((t) => t !== 'null') as
      | NormalisedType['primary']
      | undefined;
    if (!nonNull) return undefined;
    return { primary: nonNull, nullable };
  }
  return undefined;
}

/* ── parser ───────────────────────────────────────────────────────────── */

export interface BuildParserResult {
  /** Parses argv tail (everything after `<cli> <slug> <cmd> [id]`). */
  parse(argv: string[], httpMethod: string): ParsedArgs;
  /** Status of the underlying schema. */
  status: SchemaSupportStatus;
}

export function buildFlagParser(
  schema: Record<string, unknown> | undefined,
  options: ParserOptions = {},
): BuildParserResult {
  const status: SchemaSupportStatus = options.positionalOnly
    ? { kind: 'unsupported', reason: 'forced positional' }
    : classifySchema(schema);

  if (status.kind !== 'ok') {
    return { status, parse: makePositionalParser() };
  }
  return {
    status,
    parse: makeRichParser(schema as Record<string, unknown>),
  };
}

function makePositionalParser() {
  return (argv: string[], httpMethod: string): ParsedArgs => {
    // Single positional JSON payload accepted (or empty).
    const positional = argv.find((a) => !a.startsWith('-'));
    if (!positional) {
      return { body: {}, query: {}, fromPositional: true };
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(positional) as Record<string, unknown>;
    } catch (error) {
      throw new Error(
        `Could not parse positional JSON argument: ${(error as Error).message}`,
      );
    }
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed)
    ) {
      throw new Error('Positional JSON argument must be an object.');
    }
    if (httpMethod === 'GET') {
      return {
        body: {},
        query: objectToQuery(parsed),
        fromPositional: true,
      };
    }
    return { body: parsed, query: {}, fromPositional: true };
  };
}

function makeRichParser(schema: Record<string, unknown>) {
  const props = (schema.properties ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const required = new Set(((schema.required ?? []) as string[]) ?? []);
  const additionalProperties = schema.additionalProperties !== false;

  return (argv: string[], httpMethod: string): ParsedArgs => {
    const out: Record<string, unknown> = {};
    let positionalJson: Record<string, unknown> | undefined;

    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i] as string;

      // Positional JSON payload — always accepted as escape hatch.
      if (!arg.startsWith('-')) {
        if (positionalJson) {
          throw new Error(`Unexpected extra positional argument: ${arg}`);
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(arg);
        } catch {
          throw new Error(
            `Unknown positional argument (not valid JSON): ${arg}`,
          );
        }
        if (
          parsed === null ||
          typeof parsed !== 'object' ||
          Array.isArray(parsed)
        ) {
          throw new Error('Positional JSON argument must be an object.');
        }
        positionalJson = parsed as Record<string, unknown>;
        continue;
      }

      if (arg === '--') break;

      // --no-<flag> for boolean negation.
      if (arg.startsWith('--no-')) {
        const flagName = arg.slice('--no-'.length);
        const prop = props[flagName];
        if (!prop) {
          if (additionalProperties) {
            out[flagName] = false;
            continue;
          }
          throw new Error(`Unknown flag: ${arg}`);
        }
        const t = normaliseType(prop);
        if (t?.primary !== 'boolean') {
          throw new Error(`--no-${flagName} requires a boolean flag.`);
        }
        out[flagName] = false;
        continue;
      }

      // --flag=value or --flag value.
      let key: string;
      let value: string | undefined;
      const eqIdx = arg.indexOf('=');
      if (eqIdx >= 0) {
        key = arg.slice(2, eqIdx);
        value = arg.slice(eqIdx + 1);
      } else {
        key = arg.slice(2);
        const prop = props[key];
        const t = prop ? normaliseType(prop) : undefined;
        if (t?.primary === 'boolean') {
          // Boolean accepts the spaced literal form too: `--flag true`
          // and `--flag false`. Without this peek, `--flag false` would
          // toggle the flag to true and then try to parse `false` as the
          // next positional, which (a) is surprising and (b) errors out
          // as "not valid JSON". Anything else after `--flag` is left
          // for the next loop iteration (default = true).
          const next = argv[i + 1];
          if (next === 'true' || next === 'false') {
            out[key] = next === 'true';
            i += 1;
            continue;
          }
          out[key] = true;
          continue;
        }
        // Otherwise consume the next argv item.
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('-')) {
          throw new Error(`Flag --${key} requires a value.`);
        }
        value = next;
        i += 1;
      }

      const prop = props[key];
      if (!prop) {
        if (!additionalProperties) {
          throw new Error(`Unknown flag: --${key}`);
        }
        // Pass through as string.
        appendValue(out, key, value);
        continue;
      }
      const t = normaliseType(prop);
      if (!t) throw new Error(`Unknown flag: --${key}`);

      if (t.nullable && value === 'null') {
        out[key] = null;
        continue;
      }

      switch (t.primary) {
        case 'string': {
          const allowed = prop.enum as string[] | undefined;
          if (allowed && !allowed.includes(value)) {
            throw new Error(
              `--${key}: expected one of ${allowed.join(', ')}; got ${JSON.stringify(value)}.`,
            );
          }
          out[key] = value;
          break;
        }
        case 'integer': {
          const n = Number(value);
          if (!Number.isInteger(n)) {
            throw new Error(
              `--${key}: expected integer; got ${JSON.stringify(value)}.`,
            );
          }
          out[key] = n;
          break;
        }
        case 'number': {
          const n = Number(value);
          if (Number.isNaN(n)) {
            throw new Error(
              `--${key}: expected number; got ${JSON.stringify(value)}.`,
            );
          }
          out[key] = n;
          break;
        }
        case 'boolean': {
          // Explicit value form: --flag=true / --flag=false.
          if (value === 'true' || value === 'false') {
            out[key] = value === 'true';
          } else {
            throw new Error(
              `--${key}: boolean accepts true/false; got ${JSON.stringify(value)}.`,
            );
          }
          break;
        }
        case 'array': {
          const items = prop.items as Record<string, unknown> | undefined;
          const itemsType = items?.type;
          const parts = value.includes(',') ? value.split(',') : [value];
          const arr: unknown[] = Array.isArray(out[key])
            ? (out[key] as unknown[])
            : [];
          for (const part of parts) {
            arr.push(coerce(part, itemsType as string));
          }
          out[key] = arr;
          break;
        }
        default:
          throw new Error(`--${key}: unsupported schema type ${t.primary}.`);
      }
    }

    // Positional JSON overrides defaults but loses to explicit flags:
    // merge it BEFORE defaults so defaults only fill remaining holes.
    if (positionalJson) {
      for (const [k, v] of Object.entries(positionalJson)) {
        if (out[k] === undefined) out[k] = v;
      }
    }

    // Apply defaults for properties that weren't set by flags or positional.
    for (const [name, prop] of Object.entries(props)) {
      if (out[name] !== undefined) continue;
      if (prop.default !== undefined) {
        out[name] = prop.default;
      }
    }

    // Required check.
    for (const name of required) {
      if (out[name] === undefined) {
        throw new Error(`Missing required flag: --${name}`);
      }
    }

    if (httpMethod === 'GET') {
      return { body: {}, query: objectToQuery(out), fromPositional: false };
    }
    return { body: out, query: {}, fromPositional: false };
  };
}

function appendValue(
  out: Record<string, unknown>,
  key: string,
  value: string,
): void {
  if (out[key] === undefined) {
    out[key] = value;
  } else if (Array.isArray(out[key])) {
    (out[key] as unknown[]).push(value);
  } else {
    out[key] = [out[key], value];
  }
}

function coerce(value: string, type: string | undefined): unknown {
  if (type === 'integer') {
    const n = Number(value);
    if (!Number.isInteger(n)) throw new Error(`expected integer; got ${value}`);
    return n;
  }
  if (type === 'number') {
    const n = Number(value);
    if (Number.isNaN(n)) throw new Error(`expected number; got ${value}`);
    return n;
  }
  return value;
}

function objectToQuery(
  obj: Record<string, unknown>,
): Record<string, string | string[]> {
  const q: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      q[k] = v.map((x) => String(x));
    } else {
      q[k] = String(v);
    }
  }
  return q;
}
