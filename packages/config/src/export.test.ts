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
