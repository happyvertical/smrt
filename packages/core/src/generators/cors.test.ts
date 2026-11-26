import { describe, expect, it } from 'vitest';
import {
  applyCorsHeaders,
  CORS_ALLOWED_HEADERS,
  CORS_ALLOWED_METHODS,
  corsPreflightHeaders,
  corsPreflightResponse,
  corsResponseHeaders,
  isCorsEnabled,
  normalizeCorsOrigins,
  resolveCorsOrigin,
} from './cors';

const APP = 'https://app.example.com';
const EVIL = 'https://evil.example.com';
const config = { allowedOrigins: [APP] };

function req(origin?: string) {
  return new Request('https://api.example.com/x', {
    headers: origin ? { origin } : {},
  });
}

describe('normalizeCorsOrigins', () => {
  it('trims, de-duplicates, and drops empties, non-strings and wildcards', () => {
    expect(
      normalizeCorsOrigins([` ${APP} `, APP, '', '  ', '*', 5, null]),
    ).toEqual([APP]);
  });
  it('is empty for anything that is not a list', () => {
    expect(normalizeCorsOrigins(undefined)).toEqual([]);
    expect(normalizeCorsOrigins('*')).toEqual([]);
  });
});

describe('resolveCorsOrigin', () => {
  it('echoes only an exact allow-listed origin', () => {
    expect(resolveCorsOrigin(APP, config)).toBe(APP);
    expect(resolveCorsOrigin(EVIL, config)).toBeNull();
    expect(resolveCorsOrigin(`${APP}/`, config)).toBeNull();
    expect(resolveCorsOrigin(null, config)).toBeNull();
  });
  it('never resolves anything from an empty or wildcard list', () => {
    expect(resolveCorsOrigin(APP, undefined)).toBeNull();
    expect(resolveCorsOrigin(APP, { allowedOrigins: [] })).toBeNull();
    expect(resolveCorsOrigin(APP, { allowedOrigins: ['*'] })).toBeNull();
    expect(resolveCorsOrigin('*', { allowedOrigins: ['*'] })).toBeNull();
  });
});

describe('isCorsEnabled', () => {
  it('needs a non-empty allow-list', () => {
    expect(isCorsEnabled(undefined)).toBe(false);
    expect(isCorsEnabled({ allowedOrigins: ['*'] })).toBe(false);
    expect(isCorsEnabled(config)).toBe(true);
  });
});

describe('corsResponseHeaders', () => {
  it('is empty for a disallowed or absent origin', () => {
    expect(corsResponseHeaders(EVIL, config)).toEqual({});
    expect(corsResponseHeaders(null, config)).toEqual({});
    expect(corsResponseHeaders(APP, undefined)).toEqual({});
  });
  it('echoes the origin with Vary and no credentials by default', () => {
    expect(corsResponseHeaders(APP, config)).toEqual({
      'Access-Control-Allow-Origin': APP,
      Vary: 'Origin',
      'Access-Control-Allow-Methods': CORS_ALLOWED_METHODS,
      'Access-Control-Allow-Headers': CORS_ALLOWED_HEADERS,
    });
  });
  it('adds credentials only when opted in with an allowed origin', () => {
    const creds = { ...config, allowCredentials: true };
    expect(
      corsResponseHeaders(APP, creds)['Access-Control-Allow-Credentials'],
    ).toBe('true');
    expect(corsResponseHeaders(EVIL, creds)).toEqual({});
    expect(
      corsResponseHeaders(APP, {
        allowedOrigins: ['*'],
        allowCredentials: true,
      }),
    ).toEqual({});
    expect(
      corsResponseHeaders(APP, { allowedOrigins: [], allowCredentials: true }),
    ).toEqual({});
  });
});

describe('corsPreflightHeaders', () => {
  it('answers with methods, headers and max-age, plus the origin when allowed', () => {
    expect(
      corsPreflightHeaders(APP, { ...config, allowCredentials: true }),
    ).toEqual({
      'Access-Control-Allow-Methods': CORS_ALLOWED_METHODS,
      'Access-Control-Allow-Headers': CORS_ALLOWED_HEADERS,
      'Access-Control-Max-Age': '86400',
      'Access-Control-Allow-Origin': APP,
      Vary: 'Origin',
      'Access-Control-Allow-Credentials': 'true',
    });
  });
  it('omits origin, Vary and credentials for a disallowed origin', () => {
    const headers = corsPreflightHeaders(EVIL, {
      ...config,
      allowCredentials: true,
    });
    expect(headers).not.toHaveProperty('Access-Control-Allow-Origin');
    expect(headers).not.toHaveProperty('Vary');
    expect(headers).not.toHaveProperty('Access-Control-Allow-Credentials');
    expect(headers['Access-Control-Allow-Methods']).toBe(CORS_ALLOWED_METHODS);
  });
  it('builds a 200 empty response', async () => {
    const res = corsPreflightResponse(req(APP), config);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(APP);
  });
});

describe('applyCorsHeaders', () => {
  it('returns the same response for a disallowed origin', () => {
    const res = new Response('x');
    expect(applyCorsHeaders(res, req(EVIL), config)).toBe(res);
    expect(applyCorsHeaders(res, req(), config)).toBe(res);
  });
  it('copies status, body and headers and adds the CORS set', async () => {
    const res = new Response('{"a":1}', {
      status: 201,
      headers: { 'content-type': 'application/json' },
    });
    const out = applyCorsHeaders(res, req(APP), config);
    expect(out.status).toBe(201);
    expect(await out.text()).toBe('{"a":1}');
    expect(out.headers.get('content-type')).toBe('application/json');
    expect(out.headers.get('Access-Control-Allow-Origin')).toBe(APP);
    expect(out.headers.get('Vary')).toBe('Origin');
  });
  it('extends an existing Vary instead of replacing it', () => {
    const res = new Response('x', { headers: { Vary: 'Cookie' } });
    expect(applyCorsHeaders(res, req(APP), config).headers.get('Vary')).toBe(
      'Cookie, Origin',
    );
    const has = new Response('x', { headers: { Vary: 'origin, Cookie' } });
    expect(applyCorsHeaders(has, req(APP), config).headers.get('Vary')).toBe(
      'origin, Cookie',
    );
  });
});
