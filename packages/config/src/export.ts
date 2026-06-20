/**
 * Config export utilities for static site generation
 *
 * These utilities enable exporting database-backed agent configurations
 * to static files for SSG sites.
 *
 * @module
 */

/**
 * Patterns that identify sensitive configuration keys. Any key matching one of
 * these patterns is stripped during {@link sanitizeConfig}.
 *
 * Redaction policy
 * ----------------
 * These exports feed static-site-generation (SSG) artifacts that are typically
 * served publicly, so the cost of leaking a secret is far higher than the cost
 * of over-redacting a benign key. We therefore **bias toward over-redaction**:
 * the patterns are mostly case-insensitive *substring* matches (no word
 * boundaries) so they catch every common casing/separator convention —
 * `apiKey`, `api_key`, `API-KEY`, `apikey`, etc. A few are deliberately scoped
 * to avoid benign collisions: `\bcert\b` (not `concert`), and `oauth` /
 * `authorization` rather than a bare `auth` (which would hit `author`/`authors`).
 *
 * The previous implementation used `\b` word boundaries (e.g. `/\bauth\b/i`,
 * `/\bkey\b$/i`). In JS regex `\b` sits between a word char and a non-word char,
 * and `_`/letters/digits are all word chars, so those boundaries never fire
 * inside `camelCase` or `snake_case` identifiers — leaking keys like `api_key`,
 * `accessKey`, `authorization`, `auth_token`, `connectionString`, and `dbUrl`.
 * See issue #1357.
 *
 * To keep over-redaction targeted (rather than redacting on a bare `key`/`url`
 * substring, which would strip benign `apiEndpoint`-style nesting that legit
 * config relies on, e.g. `db: { url }`), `key`/`url` only trigger when paired
 * with a secret-adjacent qualifier (`apiKey`, `accessKey`, `dbUrl`, …).
 */
const SECRET_PATTERNS = [
  // Direct secret-bearing terms (substring, any casing/separator).
  /secret/i,
  /password/i,
  /passwd/i,
  // Short credential aliases (#1381, codex audit cross-finding): `pass` / `pwd`
  // keys that `password`/`passwd` don't cover. Segment- or camelCase-anchored
  // (a capital after a letter/digit) so `smtpPass`/`databasePwd`/`db_pass`/`pwd`
  // are stripped while `compass`/`bypass`/`passive` are not.
  /(^|[_-])pass([_-]|$)/i,
  /(^|[_-])pwd([_-]|$)/i,
  /[a-z0-9]Pass([_-]|$)/,
  /[a-z0-9]Pwd([_-]|$)/,
  /^(pass|pwd)$/i,
  /token/i,
  /credential/i,
  /private/i,
  // NB: not a bare /auth/i — that also matches benign `author`/`authors`
  // metadata (common in site/content/agent config). The segment-anchored form
  // strips a key literally named `auth` (and `auth_token`, `x_auth`,
  // `oauth_token`) without hitting `author`; `oauth`/`authorization` cover the
  // no-separator camelCase cases. (authToken/authSecret also hit /token//secret/.)
  /oauth/i,
  /authorization/i,
  /(^|[_-])auth([_-]|$)/i,
  /cookie/i,
  /salt/i,
  /passphrase/i,
  /\bcert\b/i, // cert/certificate, but not "uncertain"/"concert" style false hits
  /certificate/i,
  // Qualified "key" — only when paired with a secret-adjacent prefix, so we
  // strip apiKey/accessKey/signingKey/encryptionKey/privateKey but keep benign
  // keys such as `keywords`, `monkey`, or `keyboardShortcuts`.
  /api[_-]?key/i,
  /access[_-]?key/i,
  /secret[_-]?key/i,
  /signing[_-]?key/i,
  /encryption[_-]?key/i,
  /private[_-]?key/i,
  /public[_-]?key/i,
  /(^|[_-])key([_-]|id$|$)/i, // standalone `key`, `key_id`, `keyId`, `aws…KeyId`
  // Connection / database URLs that commonly embed credentials.
  /connection[_-]?string/i,
  /conn[_-]?str/i,
  /(^|[_-])db[_-]?url/i, // dbUrl / db_url / DB_URL
  /database[_-]?url/i,
  /datasource[_-]?url/i,
];

/** Return `true` when `key` matches any of the {@link SECRET_PATTERNS}. */
function isSecretKey(key: string): boolean {
  return SECRET_PATTERNS.some((pattern) => pattern.test(key));
}

// Credentials embedded in the *value* of an otherwise-benign key — most
// importantly DB connection strings like `postgres://user:pass@host:5432/db`
// stored under keys such as `url` / `database.url` that the key-based
// {@link SECRET_PATTERNS} deliberately don't match (#1381). Key-based redaction
// alone leaks these into the published SSG artifact. Mask the userinfo
// (`scheme://user:pass@host` → `scheme://***@host`) while preserving the
// non-secret host so the value stays diagnosable. Not anchored/global so it
// also catches a credential URL embedded mid-string (e.g. `dsn: postgres://u:p@h`)
// or multiple URLs in one value (review #1549).
const CREDENTIAL_URL_RE = /([a-z][a-z0-9+.-]*:\/\/)[^/?#@\s]+@/gi;

/**
 * High-confidence secret *token* shapes that can appear in the value of an
 * otherwise-benign key (#1381). Key-based {@link SECRET_PATTERNS} only catch a
 * secret when the *key* is named like one — a provider token pasted into a
 * `note`, `header`, `instructions`, or `defaultModel`-adjacent field leaks
 * verbatim into the published SSG artifact. These patterns match the
 * distinctive prefixes/structures of real credentials so we can mask the token
 * while leaving surrounding prose intact. They are intentionally specific
 * (prefix- or structure-anchored) to avoid mangling benign config values.
 *
 * Coverage:
 * - OpenAI / Anthropic style `sk-...` and `sk-proj-...` (and `sk-ant-...`)
 * - GitHub PATs / app tokens: `ghp_ gho_ ghu_ ghs_ ghr_` + fine-grained `github_pat_`
 * - Slack tokens: `xox[abprs]-...`
 * - Google API keys: `AIza...`
 * - AWS access key IDs: `AKIA`/`ASIA` + 16 uppercase alnum
 * - Stripe live/test keys: `sk_live_` / `sk_test_` / `rk_live_` / `rk_test_`
 * - `Bearer <token>` Authorization header values
 * - PEM private-key blocks
 */
const VALUE_SECRET_PATTERNS: Array<{ re: RegExp; replace: string }> = [
  // PEM private key block (multi-line) — collapse the whole block.
  {
    re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/g,
    replace: '***REDACTED PRIVATE KEY***',
  },
  // OpenAI / Anthropic secret keys: sk-, sk-proj-, sk-ant-...
  { re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}/g, replace: '***' },
  // Stripe-style prefixed keys.
  { re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, replace: '***' },
  // GitHub tokens.
  { re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replace: '***' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{22,}/g, replace: '***' },
  // Slack tokens.
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, replace: '***' },
  // Google API keys.
  { re: /\bAIza[A-Za-z0-9_-]{35}/g, replace: '***' },
  // AWS access key IDs.
  { re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, replace: '***' },
  // Bearer / JWT authorization values (header strings pasted into config).
  // Case-insensitive: HTTP auth schemes are case-insensitive and clients often
  // emit lowercase `bearer ` (review #1549).
  {
    re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
    replace: 'Bearer ***',
  },
];

/**
 * Redact credentials embedded in a string value: URL userinfo plus any
 * high-confidence secret-token shape (see {@link VALUE_SECRET_PATTERNS}).
 */
function redactValueSecrets(value: string): string {
  let out = value.replace(CREDENTIAL_URL_RE, '$1***@');
  for (const { re, replace } of VALUE_SECRET_PATTERNS) {
    out = out.replace(re, replace);
  }
  return out;
}

/**
 * Deep-clone a config object, removing every key that looks like a secret.
 *
 * Keys are tested (case-insensitively, across camelCase / snake_case / kebab /
 * UPPER variants) against {@link SECRET_PATTERNS}, which cover secrets such as
 * `apiKey`/`api_key`, `password`, `secret`, `token`, `credential`, `private`,
 * `auth`/`authorization`/`oauth`, `accessKey`, `signingKey`, `encryptionKey`,
 * `connectionString`, and `dbUrl`. The policy biases toward over-redaction
 * because these exports are typically published as static, publicly served
 * assets — see {@link SECRET_PATTERNS} for the full rationale.
 *
 * Nested objects are recursively sanitized; arrays are mapped element-by-element.
 * `number` / `boolean` primitives pass through unchanged; `string` values are
 * additionally run through value-level redaction that masks credentials embedded
 * in a URL (`scheme://user:pass@host` → `scheme://***@host`) as well as
 * high-confidence secret-token shapes pasted into otherwise-benign keys
 * (OpenAI/Anthropic `sk-...`, AWS `AKIA...` access key IDs, GitHub/Slack/Google
 * tokens, `Bearer ...` headers, and PEM private-key blocks) — catching secrets
 * stored under a benign key the key-based patterns don't match.
 *
 * Own `__proto__` / `constructor` / `prototype` keys are dropped to prevent the
 * cloned result's prototype from being reassigned via the `__proto__` setter.
 *
 * This function is called automatically by {@link exportConfig} unless
 * `includeSecrets: true` is passed.
 *
 * @param config - Value to sanitize. Accepts any JSON-serializable structure.
 * @returns A new value with all secret keys omitted. `null` / `undefined` are
 *   returned as-is.
 *
 * @example
 * ```ts
 * const sanitized = sanitizeConfig({
 *   apiEndpoint: 'https://api.example.com',
 *   apiKey: 'sk-secret-123',
 *   nested: { password: 'hunter2', name: 'test' },
 * });
 * // => { apiEndpoint: 'https://api.example.com', nested: { name: 'test' } }
 * ```
 *
 * @see {@link exportConfig}
 */
export function sanitizeConfig(config: unknown): unknown {
  if (config === null || config === undefined) {
    return config;
  }

  if (Array.isArray(config)) {
    return config.map((item) => sanitizeConfig(item));
  }

  if (typeof config === 'object') {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(config)) {
      // Guard against prototype pollution: a `__proto__` own-key (e.g. from a
      // DB-backed config round-tripped through JSON.parse) would, via the
      // `result[key] = ...` setter, silently reassign the prototype of the
      // sanitized object we hand back to callers. `constructor`/`prototype`
      // are harmless as plain keys but dropped for parity with the merge
      // guards (deepMerge / mergeExportedConfig). See #1381.
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        continue;
      }

      // Skip keys that match secret patterns
      if (isSecretKey(key)) {
        continue;
      }

      // Recursively sanitize nested objects
      result[key] = sanitizeConfig(value);
    }

    return result;
  }

  // String primitives get value-level secret redaction (credentials embedded in
  // URLs under benign keys, #1381); other primitives pass through unchanged.
  if (typeof config === 'string') {
    return redactValueSecrets(config);
  }
  return config;
}

/**
 * Options accepted by {@link exportConfig}.
 */
export interface ExportConfigOptions {
  /**
   * Include secrets in the export (use with caution!)
   * @default false
   */
  includeSecrets?: boolean;

  /**
   * Output format
   * - 'json': Plain JSON format
   * - 'js': ES module format (export default)
   * @default 'json'
   */
  format?: 'json' | 'js';

  /**
   * Number of spaces for indentation
   * @default 2
   */
  indent?: number;
}

/**
 * Serialize a configuration object to a formatted string for SSG file output.
 *
 * By default, {@link sanitizeConfig} is applied before serialization to strip
 * any keys that match secret patterns (API keys, passwords, tokens, etc.).
 * Pass `includeSecrets: true` only in secured server-side contexts.
 *
 * @param config - Configuration object to export. Any JSON-serializable value.
 * @param options - Format, indentation, and secret-inclusion options.
 * @returns A JSON string, or an ES module string (`export default {...};\n`)
 *   when `format: 'js'`.
 *
 * @example
 * ```ts
 * // Write a sanitized JSON export file for SSG
 * const json = exportConfig(agentConfig);
 * await fs.writeFile('./public/config.json', json);
 * ```
 *
 * @example
 * ```ts
 * // ES module format (importable via `import config from './config.js'`)
 * const js = exportConfig(agentConfig, { format: 'js' });
 * ```
 *
 * @see {@link sanitizeConfig}
 * @see {@link parseExportedConfig}
 * @see {@link ExportConfigOptions}
 */
export function exportConfig(
  config: unknown,
  options: ExportConfigOptions = {},
): string {
  const { includeSecrets = false, format = 'json', indent = 2 } = options;

  // Sanitize unless secrets are explicitly requested
  const exportData = includeSecrets ? config : sanitizeConfig(config);

  const jsonString = JSON.stringify(exportData, null, indent);

  if (format === 'js') {
    return `export default ${jsonString};\n`;
  }

  return jsonString;
}

/**
 * Parse a config string previously produced by {@link exportConfig} back into
 * a plain JavaScript object.
 *
 * Handles both output formats:
 * - **JSON** — standard `JSON.parse`.
 * - **JS module** — strips the `export default` prefix and trailing semicolon
 *   before parsing as JSON.
 *
 * Throws a `SyntaxError` if the content is not valid JSON after stripping.
 *
 * @param content - Exported config string (`'json'` or `'js'` format).
 * @returns Parsed configuration value.
 *
 * @example
 * ```ts
 * const raw = await fs.readFile('./smrt.exported.json', 'utf8');
 * const config = parseExportedConfig(raw);
 * ```
 *
 * @see {@link exportConfig}
 * @see {@link mergeExportedConfig}
 */
export function parseExportedConfig(content: string): unknown {
  // Handle JS module format (strip export default and trailing semicolon)
  const trimmed = content.trim();
  if (trimmed.startsWith('export default')) {
    const jsonPart = trimmed
      .replace(/^export default\s*/, '')
      .replace(/;\s*$/, '');
    return JSON.parse(jsonPart);
  }

  // Plain JSON
  return JSON.parse(content);
}

/**
 * Shallow-merge an exported (DB-backed) config into a base (file-backed) config.
 *
 * Object values are deep-merged recursively. Primitive values and arrays from
 * `exportedConfig` replace their counterparts in `baseConfig`. This is a
 * one-level-smarter spread that lets file-based env overrides win when placed
 * after the spread.
 *
 * Intended for the SSG pattern where an agent exports its runtime config to a
 * static JSON file and `smrt.config.js` imports it as a base:
 *
 * @example
 * ```js
 * // smrt.config.js
 * import exported from './smrt.exported.json' with { type: 'json' };
 *
 * export default defineConfig({
 *   modules: {
 *     praeco: mergeExportedConfig(exported, {
 *       apiEndpoint: process.env.API_URL, // env override wins
 *     }),
 *   },
 * });
 * ```
 *
 * @param baseConfig - Lower-priority base (typically from the DB export file).
 * @param exportedConfig - Higher-priority overrides (typically env / file-based).
 * @returns A new merged object of type `T`.
 *
 * @see {@link exportConfig}
 * @see {@link parseExportedConfig}
 */
export function mergeExportedConfig<T extends Record<string, unknown>>(
  baseConfig: T,
  exportedConfig: Partial<T>,
): T {
  const result = { ...baseConfig };

  for (const [key, value] of Object.entries(exportedConfig)) {
    // Guard against prototype pollution when merging untrusted/DB-exported
    // input: never write to __proto__/constructor/prototype keys.
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      continue;
    }
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      result[key] !== null &&
      typeof result[key] === 'object' &&
      !Array.isArray(result[key])
    ) {
      // Deep merge objects
      (result as Record<string, unknown>)[key] = mergeExportedConfig(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      // Override primitive values and arrays
      (result as Record<string, unknown>)[key] = value;
    }
  }

  return result;
}
