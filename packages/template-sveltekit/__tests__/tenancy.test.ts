import { describe, expect, it } from 'vitest';

import {
  createTenantResolver,
  headerStrategy,
  pathPrefixStrategy,
  subdomainStrategy,
  subdomainStrategyWith,
} from '../template/src/lib/server/tenancy.js';

/**
 * Build a minimal structural RequestEvent for the resolver to consume.
 * We don't need a real SvelteKit event — the resolver is typed against a
 * narrow structural interface.
 */
function makeEvent(
  url: string,
  init?: { headers?: Record<string, string>; params?: Record<string, string> },
) {
  return {
    url: new URL(url),
    request: new Request(url, { headers: init?.headers ?? {} }),
    params: init?.params,
  };
}

describe('subdomainStrategy', () => {
  it('extracts the tenant slug from a leading subdomain', () => {
    expect(subdomainStrategy(makeEvent('https://acme.demo.local/'))).toEqual({
      tenantId: 'acme',
    });
  });

  it('returns null for the reserved `www` subdomain', () => {
    expect(subdomainStrategy(makeEvent('https://www.demo.local/'))).toEqual({
      tenantId: null,
    });
  });

  it('returns null for a bare apex domain (no leading subdomain)', () => {
    expect(subdomainStrategy(makeEvent('https://demo.local/'))).toEqual({
      tenantId: null,
    });
  });

  it('returns null for localhost', () => {
    expect(subdomainStrategy(makeEvent('http://localhost:5173/'))).toEqual({
      tenantId: null,
    });
  });

  it('returns null for a bare IPv4 host', () => {
    expect(subdomainStrategy(makeEvent('http://127.0.0.1:5173/'))).toEqual({
      tenantId: null,
    });
    expect(subdomainStrategy(makeEvent('http://192.168.1.50/'))).toEqual({
      tenantId: null,
    });
  });

  it('returns the leading label only when multiple subdomains are present', () => {
    expect(
      subdomainStrategy(makeEvent('https://acme.beta.demo.local/')),
    ).toEqual({ tenantId: 'acme' });
  });

  it('normalizes case (hostnames are case-insensitive)', () => {
    expect(subdomainStrategy(makeEvent('https://ACME.demo.local/'))).toEqual({
      tenantId: 'acme',
    });
  });

  it('also rejects the default reserved subdomains `api` and `app`', () => {
    expect(subdomainStrategy(makeEvent('https://api.demo.local/'))).toEqual({
      tenantId: null,
    });
    expect(subdomainStrategy(makeEvent('https://app.demo.local/'))).toEqual({
      tenantId: null,
    });
  });
});

describe('subdomainStrategyWith', () => {
  it('lets callers extend the reserved-subdomain set', () => {
    const strategy = subdomainStrategyWith({
      reservedSubdomains: ['www', 'admin'],
    });
    expect(strategy(makeEvent('https://admin.demo.local/'))).toEqual({
      tenantId: null,
    });
    // And confirm a normal subdomain still resolves.
    expect(strategy(makeEvent('https://acme.demo.local/'))).toEqual({
      tenantId: 'acme',
    });
  });

  it('correctly handles multi-label public suffixes when baseDomain is set', () => {
    // Regression for the round-7 finding: without baseDomain, the
    // label-count heuristic would treat `example.co.uk` (3 labels) as
    // `example` being a tenant on the `co.uk` apex. With baseDomain
    // set, the strategy strips the apex and reads only what's left.
    const strategy = subdomainStrategyWith({
      baseDomain: 'example.co.uk',
    });
    // Apex itself: not a tenant.
    expect(strategy(makeEvent('https://example.co.uk/'))).toEqual({
      tenantId: null,
    });
    // Real tenant subdomain.
    expect(strategy(makeEvent('https://acme.example.co.uk/'))).toEqual({
      tenantId: 'acme',
    });
    // Multi-label tenant subdomain — take only the leading label.
    expect(strategy(makeEvent('https://acme.beta.example.co.uk/'))).toEqual({
      tenantId: 'acme',
    });
    // Reserved subdomain.
    expect(strategy(makeEvent('https://www.example.co.uk/'))).toEqual({
      tenantId: null,
    });
    // Host that doesn't match the configured apex — explicitly null.
    expect(strategy(makeEvent('https://other.com/'))).toEqual({
      tenantId: null,
    });
  });

  it('falls back to the label-count heuristic when baseDomain is omitted', () => {
    // The heuristic IS incorrect for `.co.uk`-style apex domains;
    // this test documents the known limitation so an unsuspecting
    // user gets a deterministic (if wrong) answer rather than a
    // silent surprise.
    const strategy = subdomainStrategyWith();
    expect(strategy(makeEvent('https://example.co.uk/'))).toEqual({
      tenantId: 'example', // <-- the documented misread
    });
    // Single-label TLD case works as expected.
    expect(strategy(makeEvent('https://acme.example.com/'))).toEqual({
      tenantId: 'acme',
    });
  });

  it('merges custom reserved subdomains with the built-in defaults', () => {
    // Custom list adds `admin` but does NOT mention `www` / `api` / `app`.
    // The merge semantics should keep the defaults reserved.
    const strategy = subdomainStrategyWith({
      reservedSubdomains: ['admin'],
    });
    expect(strategy(makeEvent('https://admin.demo.local/'))).toEqual({
      tenantId: null,
    });
    expect(strategy(makeEvent('https://www.demo.local/'))).toEqual({
      tenantId: null,
    });
    expect(strategy(makeEvent('https://api.demo.local/'))).toEqual({
      tenantId: null,
    });
    expect(strategy(makeEvent('https://app.demo.local/'))).toEqual({
      tenantId: null,
    });
  });
});

describe('pathPrefixStrategy', () => {
  it('extracts the tenant slug from the default `/t/<slug>/` prefix', () => {
    const strategy = pathPrefixStrategy();
    expect(strategy(makeEvent('https://demo.local/t/acme/dashboard'))).toEqual({
      tenantId: 'acme',
    });
  });

  it('returns null when the prefix is absent', () => {
    const strategy = pathPrefixStrategy();
    expect(strategy(makeEvent('https://demo.local/dashboard'))).toEqual({
      tenantId: null,
    });
  });

  it('honors a custom prefix', () => {
    const strategy = pathPrefixStrategy({ prefix: '/tenant/' });
    expect(
      strategy(makeEvent('https://demo.local/tenant/acme/dashboard')),
    ).toEqual({ tenantId: 'acme' });
  });

  it('returns null when the slug is empty', () => {
    const strategy = pathPrefixStrategy();
    expect(strategy(makeEvent('https://demo.local/t/'))).toEqual({
      tenantId: null,
    });
  });
});

describe('headerStrategy', () => {
  it('reads the tenant id from the default `x-tenant-id` header', () => {
    const strategy = headerStrategy();
    expect(
      strategy(
        makeEvent('https://demo.local/', { headers: { 'x-tenant-id': 'acme' } }),
      ),
    ).toEqual({ tenantId: 'acme' });
  });

  it('returns null when the header is missing', () => {
    const strategy = headerStrategy();
    expect(strategy(makeEvent('https://demo.local/'))).toEqual({
      tenantId: null,
    });
  });

  it('honors a custom header name', () => {
    const strategy = headerStrategy({ headerName: 'x-my-tenant' });
    expect(
      strategy(
        makeEvent('https://demo.local/', {
          headers: { 'x-my-tenant': 'acme' },
        }),
      ),
    ).toEqual({ tenantId: 'acme' });
  });
});

describe('createTenantResolver', () => {
  it('wraps a sync strategy into an async resolver', async () => {
    const resolve = createTenantResolver(subdomainStrategy);
    await expect(
      resolve(makeEvent('https://acme.demo.local/')),
    ).resolves.toEqual({ tenantId: 'acme' });
  });

  it('wraps an async strategy too', async () => {
    const resolve = createTenantResolver(async (event) => {
      // Simulate an async DB lookup or similar.
      await Promise.resolve();
      return {
        tenantId: event.url.searchParams.get('tenant'),
      };
    });
    await expect(
      resolve(makeEvent('https://demo.local/?tenant=acme')),
    ).resolves.toEqual({ tenantId: 'acme' });
  });

  it('lets consumers compose strategies (subdomain → header fallback)', async () => {
    const resolve = createTenantResolver((event) => {
      const fromSubdomain = subdomainStrategy(event);
      if (fromSubdomain.tenantId) return fromSubdomain;
      return headerStrategy()(event);
    });
    // Subdomain wins.
    await expect(
      resolve(
        makeEvent('https://acme.demo.local/', {
          headers: { 'x-tenant-id': 'fallback' },
        }),
      ),
    ).resolves.toEqual({ tenantId: 'acme' });
    // Falls back to header when no subdomain.
    await expect(
      resolve(
        makeEvent('https://demo.local/', {
          headers: { 'x-tenant-id': 'fallback' },
        }),
      ),
    ).resolves.toEqual({ tenantId: 'fallback' });
  });
});
