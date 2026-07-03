/**
 * Unit coverage for the conditional-GET helper module: the v1 body-hash ETag
 * primitives that remain public (shape/determinism, RFC 9110 If-None-Match
 * matching, the Cache-Control policy matrix, the conditional JSON response
 * builder), and the ETag v2 emitted SvelteKit route helper (#1765).
 *
 * The v2 helper imports its version primitives from `@happyvertical/smrt-core`
 * (the version lookup is dialect-aware SQL that cannot be inlined portably), so
 * unlike the v1 snippet it can no longer be written to a bare temp module and
 * executed. Its runtime behavior — a matching If-None-Match answers 304 without
 * running the query, a write bumps the version — is covered end to end by
 * `conditional-get.spec.ts` over the SAME core primitives; here we assert the
 * emitted code's structure and the baked-in Cache-Control policy.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  computeBodyEtag,
  conditionalJsonResponse,
  generateConditionalGetRouteHelper,
  ifNoneMatchSatisfied,
  PRIVATE_READ_CACHE_CONTROL,
  resolveReadCacheControl,
  warnIfSharedCacheNeutralized,
} from './conditional-get';

describe('computeBodyEtag (#1757)', () => {
  it('produces a strong quoted ETag (no W/ prefix)', () => {
    const etag = computeBodyEtag('{"a":1}');
    expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    expect(etag.startsWith('W/')).toBe(false);
  });

  it('is deterministic for the same body and changes with the body', () => {
    expect(computeBodyEtag('{"a":1}')).toBe(computeBodyEtag('{"a":1}'));
    expect(computeBodyEtag('{"a":1}')).not.toBe(computeBodyEtag('{"a":2}'));
  });
});

describe('ifNoneMatchSatisfied (#1757)', () => {
  const etag = computeBodyEtag('body');

  it('does not match when the header is absent', () => {
    expect(ifNoneMatchSatisfied(null, etag)).toBe(false);
    expect(ifNoneMatchSatisfied(undefined, etag)).toBe(false);
    expect(ifNoneMatchSatisfied('', etag)).toBe(false);
  });

  it('matches the exact ETag', () => {
    expect(ifNoneMatchSatisfied(etag, etag)).toBe(true);
  });

  it('matches * against any representation', () => {
    expect(ifNoneMatchSatisfied('*', etag)).toBe(true);
    expect(ifNoneMatchSatisfied('  *  ', etag)).toBe(true);
  });

  it('matches within a comma-separated list', () => {
    expect(ifNoneMatchSatisfied(`"other", ${etag}, "third"`, etag)).toBe(true);
  });

  it('uses weak comparison: a W/ prefixed tag matches the strong ETag', () => {
    expect(ifNoneMatchSatisfied(`W/${etag}`, etag)).toBe(true);
  });

  it('does not match a different ETag', () => {
    expect(ifNoneMatchSatisfied('"nope"', etag)).toBe(false);
  });
});

describe('resolveReadCacheControl policy matrix (#1757)', () => {
  it('defaults to private, no-cache for missing/boolean/invalid config', () => {
    expect(resolveReadCacheControl(undefined)).toBe(PRIVATE_READ_CACHE_CONTROL);
    expect(resolveReadCacheControl(true)).toBe(PRIVATE_READ_CACHE_CONTROL);
    expect(resolveReadCacheControl(false)).toBe(PRIVATE_READ_CACHE_CONTROL);
    expect(resolveReadCacheControl('nope')).toBe(PRIVATE_READ_CACHE_CONTROL);
    expect(resolveReadCacheControl({})).toBe(PRIVATE_READ_CACHE_CONTROL);
  });

  it('stays private for public models without a cache opt-in', () => {
    expect(resolveReadCacheControl({ public: true })).toBe(
      PRIVATE_READ_CACHE_CONTROL,
    );
    expect(resolveReadCacheControl({ public: true, cache: {} })).toBe(
      PRIVATE_READ_CACHE_CONTROL,
    );
  });

  it('emits shared-cache headers for public models with a positive sMaxage', () => {
    expect(
      resolveReadCacheControl({ public: true, cache: { sMaxage: 300 } }),
    ).toBe('public, max-age=0, s-maxage=300');
  });

  it("honors public: 'read' (reads are public) for shared caching", () => {
    expect(
      resolveReadCacheControl({ public: 'read', cache: { sMaxage: 60 } }),
    ).toBe('public, max-age=0, s-maxage=60');
  });

  it('NEVER emits shared-cache headers for non-public models, even with sMaxage', () => {
    for (const config of [
      { cache: { sMaxage: 600 } },
      { public: false, cache: { sMaxage: 600 } },
      { public: 'write', cache: { sMaxage: 600 } },
    ]) {
      const value = resolveReadCacheControl(config);
      expect(value).toBe(PRIVATE_READ_CACHE_CONTROL);
      expect(value).not.toContain('s-maxage');
      expect(value).not.toContain('public');
    }
  });

  it('ignores non-positive or non-numeric sMaxage values', () => {
    for (const sMaxage of [
      0,
      -5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '300',
    ]) {
      expect(
        resolveReadCacheControl({ public: true, cache: { sMaxage } }),
      ).toBe(PRIVATE_READ_CACHE_CONTROL);
    }
  });

  it('floors fractional sMaxage values', () => {
    expect(
      resolveReadCacheControl({ public: true, cache: { sMaxage: 12.9 } }),
    ).toBe('public, max-age=0, s-maxage=12');
  });

  // Cross-tenant cache-leak guard (#1757 review): a tenant-scoped model's
  // body varies with the session-cookie tenant context, which URL-keyed
  // shared caches cannot see. If someone re-enables this combination without
  // a deliberate cache-keying design, these MUST fail.
  it('tenant-scoped models NEVER emit shared-cache headers, even public + sMaxage', () => {
    for (const config of [
      { public: true, cache: { sMaxage: 300 } },
      { public: 'read', cache: { sMaxage: 300 } },
      { public: true },
      { cache: { sMaxage: 300 } },
    ]) {
      const value = resolveReadCacheControl(config, { tenantScoped: true });
      expect(value).toBe(PRIVATE_READ_CACHE_CONTROL);
      expect(value).not.toContain('s-maxage');
      expect(value).not.toContain('public');
    }
  });

  it('tenantScoped: false preserves the shared-cache opt-in', () => {
    expect(
      resolveReadCacheControl(
        { public: true, cache: { sMaxage: 300 } },
        { tenantScoped: false },
      ),
    ).toBe('public, max-age=0, s-maxage=300');
  });
});

describe('warnIfSharedCacheNeutralized (#1757)', () => {
  const neutralizedConfig = { public: 'read', cache: { sMaxage: 120 } };

  it('warns once per model when a tenant-scoped model configures sMaxage', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      warnIfSharedCacheNeutralized('WarnOnceModel', neutralizedConfig, true);
      warnIfSharedCacheNeutralized('WarnOnceModel', neutralizedConfig, true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('WarnOnceModel');
      expect(warn.mock.calls[0][0]).toContain('sMaxage');
      expect(warn.mock.calls[0][0]).toContain('private, no-cache');
    } finally {
      warn.mockRestore();
    }
  });

  it('stays silent for safe configurations', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Not tenant-scoped: the knob is honored, nothing to warn about.
      warnIfSharedCacheNeutralized('SilentModelA', neutralizedConfig, false);
      // Tenant-scoped but no shared-cache opt-in: nothing was neutralized.
      warnIfSharedCacheNeutralized('SilentModelB', { public: true }, true);
      warnIfSharedCacheNeutralized('SilentModelC', undefined, true);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('conditionalJsonResponse (#1757)', () => {
  const payload = { hello: 'world' };
  const etag = computeBodyEtag(JSON.stringify(payload));

  it('returns 200 with ETag, Cache-Control, and the JSON body', async () => {
    const res = conditionalJsonResponse(
      new Request('http://local/x'),
      payload,
      PRIVATE_READ_CACHE_CONTROL,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('etag')).toBe(etag);
    expect(res.headers.get('cache-control')).toBe(PRIVATE_READ_CACHE_CONTROL);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual(payload);
  });

  it('returns 304 with an EMPTY body when If-None-Match matches', async () => {
    const res = conditionalJsonResponse(
      new Request('http://local/x', {
        headers: { 'if-none-match': etag },
      }),
      payload,
      PRIVATE_READ_CACHE_CONTROL,
    );
    expect(res.status).toBe(304);
    expect(res.headers.get('etag')).toBe(etag);
    expect(res.headers.get('cache-control')).toBe(PRIVATE_READ_CACHE_CONTROL);
    expect(await res.text()).toBe('');
  });

  it('returns 200 when If-None-Match carries a stale ETag', async () => {
    const res = conditionalJsonResponse(
      new Request('http://local/x', {
        headers: { 'if-none-match': '"stale"' },
      }),
      payload,
      PRIVATE_READ_CACHE_CONTROL,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(payload);
  });
});

describe('emitted SvelteKit route helper: ETag v2 structure (#1765)', () => {
  it('imports the version primitives from smrt-core and derives the ETag from the table version', () => {
    const snippet = generateConditionalGetRouteHelper({ public: false });
    expect(snippet).toContain("from '@happyvertical/smrt-core'");
    for (const primitive of [
      'getTableVersion',
      'computeTableVersionEtag',
      'canonicalReadRepresentation',
      'ifNoneMatchSatisfied',
    ]) {
      expect(snippet).toContain(primitive);
    }
    // The emitted helper is the query-skipping shape the routes wrap their
    // query in, not the v1 body-hash conditionalJson.
    expect(snippet).toContain('async function conditionalVersionedRead(');
    expect(snippet).not.toContain('function bodyEtag(');
    // Imports the concrete-match helper too (the wildcard-safe fast path).
    expect(snippet).toContain('ifNoneMatchHasConcreteMatch');
  });

  it('takes the fast path only on a CONCRETE match, before building the payload (zero-query invariant)', () => {
    const snippet = generateConditionalGetRouteHelper({ public: false });
    const concreteGuard = snippet.indexOf(
      'ifNoneMatchHasConcreteMatch(ifNoneMatch',
    );
    const buildIndex = snippet.indexOf('await buildPayload()');
    const wildcardCheck = snippet.indexOf('ifNoneMatchSatisfied(ifNoneMatch');
    expect(concreteGuard).toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(wildcardCheck).toBeGreaterThanOrEqual(0);
    // The concrete-match short-circuit must precede the query thunk (the point
    // of ETag v2)...
    expect(concreteGuard).toBeLessThan(buildIndex);
    // ...and the wildcard `*` check must come AFTER the build, so a `304` is
    // never returned for a row the build could not produce (a missing item).
    expect(buildIndex).toBeLessThan(wildcardCheck);
  });

  it('bakes the private default policy in as a constant', () => {
    const snippet = generateConditionalGetRouteHelper({ public: false });
    expect(snippet).toContain(
      `const READ_CACHE_CONTROL = '${PRIVATE_READ_CACHE_CONTROL}';`,
    );
  });

  it('bakes the shared policy in for public models with sMaxage', () => {
    const snippet = generateConditionalGetRouteHelper({
      public: true,
      cache: { sMaxage: 120 },
    });
    expect(snippet).toContain(
      "const READ_CACHE_CONTROL = 'public, max-age=0, s-maxage=120';",
    );
  });

  it('bakes the private policy for tenant-scoped models even with public + sMaxage', () => {
    const snippet = generateConditionalGetRouteHelper(
      { public: 'read', cache: { sMaxage: 600 } },
      { tenantScoped: true },
    );
    expect(snippet).toContain(
      `const READ_CACHE_CONTROL = '${PRIVATE_READ_CACHE_CONTROL}';`,
    );
    expect(snippet).not.toContain('s-maxage');
  });

  it('folds the active tenant into the representation for tenant-scoped models', () => {
    const tenant = generateConditionalGetRouteHelper(
      { public: false },
      { tenantScoped: true },
    );
    // Imports and calls the shared tenant discriminator.
    expect(tenant).toContain('resolveTenantEtagDiscriminator');
    expect(tenant).toContain(
      'canonicalReadRepresentation(request, resolveTenantEtagDiscriminator())',
    );
  });

  it('omits the tenant discriminator for non-tenant-scoped models', () => {
    const plain = generateConditionalGetRouteHelper({ public: false });
    expect(plain).not.toContain('resolveTenantEtagDiscriminator');
    expect(plain).toContain('canonicalReadRepresentation(request, undefined)');
  });

  it('emits the v1 body-hash helper (not the version source) when useBodyHash is set', () => {
    // Serializer-backed routes can render related-table data the per-table
    // version cannot observe (#1765), so they keep the v1 body-hash ETag.
    const snippet = generateConditionalGetRouteHelper(
      { public: false },
      { useBodyHash: true },
    );
    expect(snippet).toContain("import { createHash } from 'node:crypto';");
    expect(snippet).toContain('function conditionalJson(');
    expect(snippet).not.toContain('conditionalVersionedRead');
    expect(snippet).not.toContain('@happyvertical/smrt-core');
    // The Cache-Control policy is still baked in.
    expect(snippet).toContain(
      `const READ_CACHE_CONTROL = '${PRIVATE_READ_CACHE_CONTROL}';`,
    );
  });
});
