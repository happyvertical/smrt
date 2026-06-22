import { describe, expect, it } from 'vitest';
import {
  exportConfig,
  mergeExportedConfig,
  parseExportedConfig,
  sanitizeConfig,
} from './export.js';

/**
 * Regression coverage for the SSG secret-leak fix (issue #1357).
 *
 * The original `sanitizeConfig` patterns used `\b` word boundaries
 * (`/\bauth\b/i`, `/\bkey\b$/i`) that never matched inside camelCase /
 * snake_case identifiers, so secret-bearing keys leaked into exported
 * (publicly served) SSG artifacts. These tests pin down that every common
 * secret-key casing is stripped while benign config keys survive.
 */
describe('sanitizeConfig — secret-key stripping (issue #1357)', () => {
  // Every variant here was a *verified leak* under the old word-boundary
  // patterns. Each must now be stripped from a sanitized export.
  const leakedSecretKeys = [
    // api key — snake / UPPER / kebab / camel / flat
    'api_key',
    'API_KEY',
    'api-key',
    'apiKey',
    'apikey',
    // access keys
    'accessKey',
    'access_key',
    'awsAccessKeyId',
    'AWS_ACCESS_KEY_ID',
    // other qualified keys
    'encryptionKey',
    'encryption_key',
    'signingKey',
    'signing_key',
    'privateKey',
    'private_key',
    'secretKey',
    'secret_key',
    // camelCase <vendor>Key keys — verified leaks until the `[a-z0-9]Key`
    // pattern was added; their unlisted vendor prefix bypassed the hardcoded
    // api/access/secret/signing/encryption/private/public prefixes and the
    // segment-anchored standalone-`key` pattern.
    'consumerKey',
    'masterKey',
    'sslKey',
    'hmacKey',
    'sharedKey',
    'rootKey',
    'clientKey',
    'serverKey',
    'deployKey',
    'sshKey',
    'consumerKeyId',
    // auth family
    'auth',
    'authorization',
    'Authorization',
    'oauth',
    'oauth_token',
    'auth_token',
    'authToken',
    // generic secret terms
    'secret',
    'clientSecret',
    'sessionSecret',
    'session_secret',
    'token',
    'accessToken',
    'refresh_token',
    'password',
    'PASSWORD',
    'passwd',
    'passphrase',
    'credential',
    'credentials',
    'cookie',
    'salt',
    'cert',
    'certificate',
    // connection / db urls (frequently embed credentials)
    'connectionString',
    'connection_string',
    'connStr',
    'conn_str',
    'dbUrl',
    'db_url',
    'DB_URL',
    'databaseUrl',
    'database_url',
    'datasourceUrl',
  ];

  it.each(
    leakedSecretKeys,
  )('strips secret key %p from a top-level object', (key) => {
    const input = { [key]: 'sk-super-secret', keep: 'value' };
    const out = sanitizeConfig(input) as Record<string, unknown>;
    expect(out).not.toHaveProperty(key);
    expect(out.keep).toBe('value');
  });

  it.each(leakedSecretKeys)('strips secret key %p when nested', (key) => {
    const input = { nested: { [key]: 'sk-super-secret', name: 'svc' } };
    const out = sanitizeConfig(input) as {
      nested: Record<string, unknown>;
    };
    expect(out.nested).not.toHaveProperty(key);
    expect(out.nested.name).toBe('svc');
  });

  it.each(
    leakedSecretKeys,
  )('strips secret key %p inside array elements', (key) => {
    const input = { items: [{ [key]: 'sk-x', label: 'a' }] };
    const out = sanitizeConfig(input) as {
      items: Array<Record<string, unknown>>;
    };
    expect(out.items[0]).not.toHaveProperty(key);
    expect(out.items[0].label).toBe('a');
  });

  // Benign keys must NOT be stripped — over-redaction is acceptable, but we
  // should not destroy normal config (esp. endpoints, names, and `db.url`,
  // which existing config relies on and is not itself a credential).
  const benignKeys = [
    'name',
    'enabled',
    'maxItems',
    'logLevel',
    'cacheDir',
    'defaultModel',
    'defaultProvider',
    'timeout',
    'headless',
    'count',
    'retries',
    'apiEndpoint',
    'apiUrl',
    'apiVersion',
    'url',
    'db',
    'baseUrl',
    'endpoint',
    'host',
    'port',
    'region',
    'keyboardShortcuts',
    'keywords',
    'monkey',
    'description',
    'title',
    // #1357 review (codex): the `auth` matcher must NOT redact benign author
    // metadata (common in site/content/agent config exported for SSG).
    'author',
    'authors',
  ];

  it.each(benignKeys)('preserves benign key %p', (key) => {
    const input = { [key]: 'plain-value' };
    const out = sanitizeConfig(input) as Record<string, unknown>;
    expect(out[key]).toBe('plain-value');
  });

  it('preserves nested db.url (not a credential key)', () => {
    const out = sanitizeConfig({ db: { url: ':memory:' } }) as {
      db: { url: string };
    };
    expect(out.db.url).toBe(':memory:');
  });

  it('redacts credentials embedded in a URL value under a benign key (#1381)', () => {
    // Key-based redaction misses a DSN stored under a benign `url` key; the
    // value-level pass masks the userinfo while keeping the host diagnosable.
    const out = sanitizeConfig({
      cli: { database: { url: 'postgresql://user:pass@host:5432/db' } },
    }) as { cli: { database: { url: string } } };
    expect(out.cli.database.url).toBe('postgresql://***@host:5432/db');
  });

  it('strips short credential aliases pass/pwd (#1381 codex cross-finding)', () => {
    const out = sanitizeConfig({
      smtp: {
        user: 'svc',
        pass: 'x',
        pwd: 'y',
        smtpPass: 'z',
        databasePwd: 'w',
      },
    }) as { smtp: Record<string, unknown> };
    expect(out.smtp).toEqual({ user: 'svc' });
  });

  it('does not over-redact benign words containing pass/pwd', () => {
    const out = sanitizeConfig({
      compass: 'n',
      bypass: true,
      passive: false,
      password_hint_enabled: false,
    }) as Record<string, unknown>;
    expect(out).toHaveProperty('compass');
    expect(out).toHaveProperty('bypass');
    expect(out).toHaveProperty('passive');
  });

  it('leaves credential-free URLs and :memory: untouched', () => {
    expect(sanitizeConfig('https://api.example.com/v1')).toBe(
      'https://api.example.com/v1',
    );
    expect(sanitizeConfig(':memory:')).toBe(':memory:');
    expect(sanitizeConfig('redis://cache.internal:6379')).toBe(
      'redis://cache.internal:6379',
    );
  });

  it('returns null/undefined unchanged', () => {
    expect(sanitizeConfig(null)).toBeNull();
    expect(sanitizeConfig(undefined)).toBeUndefined();
  });

  it('passes primitive values through unchanged', () => {
    expect(sanitizeConfig('hello')).toBe('hello');
    expect(sanitizeConfig(42)).toBe(42);
    expect(sanitizeConfig(true)).toBe(true);
  });

  it('sanitizes a realistic mixed agent config', () => {
    const input = {
      smrt: { logLevel: 'debug', cacheDir: '.cache' },
      packages: {
        ai: {
          defaultProvider: 'openai',
          defaultModel: 'gpt-4',
          apiKey: 'sk-leak-me',
          API_KEY: 'sk-also-leak',
        },
        db: {
          url: ':memory:',
          connectionString: 'postgres://user:pw@host/db',
          dbUrl: 'postgres://user:pw@host/db',
        },
      },
      auth: { authToken: 'tok', oauth: 'x' },
    };
    const out = sanitizeConfig(input) as Record<string, any>;

    expect(out.smrt).toEqual({ logLevel: 'debug', cacheDir: '.cache' });
    expect(out.packages.ai).toEqual({
      defaultProvider: 'openai',
      defaultModel: 'gpt-4',
    });
    expect(out.packages.db).toEqual({ url: ':memory:' });
    // `auth` itself is a secret-adjacent key → whole subtree dropped.
    expect(out).not.toHaveProperty('auth');
  });
});

describe('sanitizeConfig — value-level secret-token redaction (#1381)', () => {
  // A secret pasted into the VALUE of a benign key is not caught by key-based
  // patterns and would leak verbatim into the published SSG artifact.
  it('redacts an OpenAI sk- key embedded in a benign string value', () => {
    const out = sanitizeConfig({
      note: `my key is sk${'-proj-'}abcdEFGH1234567890abcdEFGH keep safe`,
    }) as { note: string };
    expect(out.note).not.toContain(`sk${'-proj-'}abcdEFGH1234567890abcdEFGH`);
    expect(out.note).toContain('***');
    // Surrounding prose is preserved.
    expect(out.note).toContain('my key is');
    expect(out.note).toContain('keep safe');
  });

  it('redacts sk-ant- and bare sk- tokens', () => {
    const out = sanitizeConfig({
      a: `sk${'-ant-'}api03-ABCdefGHIjklMNOpqrSTUvwx`,
      b: `sk${'-'}ABCdefGHIjklMNOpqrSTUvwx12`,
    }) as Record<string, string>;
    expect(out.a).toBe('***');
    expect(out.b).toBe('***');
  });

  it('redacts AWS access key IDs in values', () => {
    const out = sanitizeConfig({
      example: 'AKIAIOSFODNN7EXAMPLE',
      temp: 'ASIAIOSFODNN7EXAMPLE',
    }) as Record<string, string>;
    expect(out.example).toBe('***');
    expect(out.temp).toBe('***');
  });

  it('redacts GitHub, Slack, Google, and Stripe tokens in values', () => {
    // Build fixtures from split prefixes so this file does not embed any
    // contiguous live-key literal that trips push-protection secret scanning.
    // The runtime string still carries the full prefix the redactor matches.
    const ghToken = `gh${'p'}_0123456789abcdef0123456789abcdef0123`;
    const slackToken = `xo${'xb'}-1234567890-abcdefghijklmnop`;
    const googleKey = `AI${'za'}SyA1234567890abcdefghijklmnopqrstuv`;
    const stripeKey = `sk${'_live_'}0123456789abcdefABCDEFGH`;
    const out = sanitizeConfig({
      gh: ghToken,
      slack: slackToken,
      google: googleKey,
      stripe: stripeKey,
    }) as Record<string, string>;
    expect(out.gh).toBe('***');
    expect(out.slack).toBe('***');
    expect(out.google).toBe('***');
    expect(out.stripe).toBe('***');
  });

  it('masks Bearer authorization values pasted into benign keys', () => {
    const out = sanitizeConfig({
      defaultHeader:
        'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature',
    }) as { defaultHeader: string };
    expect(out.defaultHeader).toBe('Bearer ***');
  });

  it('masks lowercase/mixed-case bearer headers (review #1549)', () => {
    const out = sanitizeConfig({
      a: 'bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature',
      b: 'BEARER eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature',
    }) as Record<string, string>;
    // Redaction normalizes any casing to the canonical `Bearer ***`.
    expect(out.a).toBe('Bearer ***');
    expect(out.b).toBe('Bearer ***');
  });

  it('masks URL userinfo mid-string and for multiple URLs (review #1549)', () => {
    const out = sanitizeConfig({
      dsn: 'primary postgres://user:pass@db1/app then redis://u2:p2@cache:6379',
    }) as { dsn: string };
    expect(out.dsn).not.toContain('user:pass');
    expect(out.dsn).not.toContain('u2:p2');
    expect(out.dsn).toContain('postgres://***@db1/app');
    expect(out.dsn).toContain('redis://***@cache:6379');
  });

  it('redacts PEM private-key blocks embedded in values', () => {
    const pem =
      '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQ\nfoo==\n-----END PRIVATE KEY-----';
    // Use a benign key name so we exercise value-level (not key-based) redaction.
    const out = sanitizeConfig({ instructions: pem }) as {
      instructions: string;
    };
    expect(out.instructions).not.toContain('MIIEvQ');
    expect(out.instructions).toContain('***REDACTED PRIVATE KEY***');
  });

  it('leaves benign string values untouched', () => {
    const out = sanitizeConfig({
      model: 'gpt-4o-mini',
      endpoint: 'https://api.example.com/v1',
      note: 'no secrets here, just a sentence about keys generally',
    }) as Record<string, string>;
    expect(out.model).toBe('gpt-4o-mini');
    expect(out.endpoint).toBe('https://api.example.com/v1');
    expect(out.note).toBe(
      'no secrets here, just a sentence about keys generally',
    );
  });

  it('redacts secret tokens nested in arrays and objects', () => {
    const tok = `sk${'-proj-'}ABCDEFGHIJKLMNOPQRSTUV`;
    const out = sanitizeConfig({
      items: [{ label: 'a', blob: `token ${tok}` }],
    }) as { items: Array<{ label: string; blob: string }> };
    expect(out.items[0].label).toBe('a');
    expect(out.items[0].blob).not.toContain(tok);
    expect(out.items[0].blob).toContain('***');
  });
});

describe('sanitizeConfig — prototype pollution guard (#1381)', () => {
  it('does not reassign the prototype of the sanitized result via __proto__', () => {
    // A DB-backed config round-tripped through JSON.parse can carry a
    // `__proto__` own key. Copying it via `result[key] = ...` would invoke the
    // proto setter and reassign the cloned object's prototype.
    const malicious = JSON.parse('{"__proto__": {"polluted": true}, "a": 1}');
    const out = sanitizeConfig(malicious) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(out.a).toBe(1);
    // Assert on the OWN key specifically — `'__proto__' in out` /
    // toHaveProperty would be true via Object.prototype even when the own key
    // was dropped (review #1549).
    expect(Object.hasOwn(out, '__proto__')).toBe(false);
  });

  it('drops constructor / prototype own keys from the output', () => {
    const input = JSON.parse(
      '{"constructor": {"x": 1}, "prototype": {"y": 2}, "keep": 3}',
    );
    const out = sanitizeConfig(input) as Record<string, unknown>;
    expect(out.keep).toBe(3);
    // Own-key assertions: every object inherits `constructor`, so toHaveProperty
    // would be misleading — check own-keys explicitly (review #1549).
    expect(Object.hasOwn(out, 'constructor')).toBe(false);
    expect(Object.hasOwn(out, 'prototype')).toBe(false);
  });

  it('global Object.prototype is never polluted through export', () => {
    const malicious = JSON.parse('{"__proto__": {"pwned": true}}');
    sanitizeConfig(malicious);
    expect(({} as Record<string, unknown>).pwned).toBeUndefined();
  });
});

describe('exportConfig — secret handling', () => {
  it('strips secrets by default', () => {
    const json = exportConfig({ apiKey: 'sk-secret', name: 'svc' });
    const parsed = JSON.parse(json);
    expect(parsed).not.toHaveProperty('apiKey');
    expect(parsed.name).toBe('svc');
  });

  it('keeps the includeSecrets escape hatch working', () => {
    const json = exportConfig(
      { apiKey: 'sk-secret', name: 'svc' },
      { includeSecrets: true },
    );
    const parsed = JSON.parse(json);
    expect(parsed.apiKey).toBe('sk-secret');
    expect(parsed.name).toBe('svc');
  });

  it('strips secrets in the js module format too', () => {
    const js = exportConfig(
      { api_key: 'sk', accessToken: 't', label: 'ok' },
      { format: 'js' },
    );
    expect(js.startsWith('export default ')).toBe(true);
    const parsed = parseExportedConfig(js) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('api_key');
    expect(parsed).not.toHaveProperty('accessToken');
    expect(parsed.label).toBe('ok');
  });

  // Regression: camelCase `<vendor>Key` keys used to leak into the public SSG
  // artifact because their unlisted vendor prefix bypassed `isSecretKey` and the
  // raw hex/base64 *value* matched none of the value-level token shapes. The
  // `[a-z0-9]Key` pattern closes the gap. Benign `key`-bearing keys must survive.
  it('strips camelCase <vendor>Key secrets with raw values from the export', () => {
    const json = exportConfig({
      consumerKey: 'a3f1c0deadbeefcafe1234567890abcd',
      masterKey: 'AAAABBBBCCCCDDDDEEEEFFFF0000',
      sslKey: 'deadbeefdeadbeefdeadbeefdeadbeef',
      // benign — must remain in the public artifact
      keywords: ['news', 'sports'],
      monkey: 'business',
      keyboardShortcuts: { save: 'cmd+s' },
    });
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('consumerKey');
    expect(parsed).not.toHaveProperty('masterKey');
    expect(parsed).not.toHaveProperty('sslKey');
    expect(parsed.keywords).toEqual(['news', 'sports']);
    expect(parsed.monkey).toBe('business');
    expect(parsed.keyboardShortcuts).toEqual({ save: 'cmd+s' });
  });
});

describe('mergeExportedConfig — prototype pollution guard', () => {
  it('does not pollute Object.prototype via __proto__', () => {
    const malicious = JSON.parse('{"__proto__": {"polluted": true}}');
    mergeExportedConfig({ safe: true } as Record<string, unknown>, malicious);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('does not pollute via constructor key', () => {
    const malicious = JSON.parse(
      '{"constructor": {"prototype": {"polluted2": true}}}',
    );
    mergeExportedConfig({ safe: true } as Record<string, unknown>, malicious);
    expect(({} as Record<string, unknown>).polluted2).toBeUndefined();
  });
});
