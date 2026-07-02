/**
 * Unit coverage for the conditional-GET helper module (#1757): body-hash ETag
 * shape and determinism, RFC 9110 If-None-Match matching, the Cache-Control
 * policy matrix (private by default, shared caching only for public models
 * that opt in), the conditional JSON response builder, and the SvelteKit
 * route-helper snippet — which is executed for real (written to a temp module
 * and imported) so the emitted code is tested behaviorally, not textually.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  computeBodyEtag,
  conditionalJsonResponse,
  generateConditionalGetRouteHelper,
  ifNoneMatchSatisfied,
  PRIVATE_READ_CACHE_CONTROL,
  resolveReadCacheControl,
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

describe('generated SvelteKit route helper snippet (#1757)', () => {
  const tempDirs: string[] = [];

  afterAll(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  /**
   * Write the emitted helper snippet to a temp module and import it, so the
   * code that ships inside generated `+server.ts` files is executed for real
   * (mirroring the sveltekit-generator.runtime.test.ts precedent).
   */
  async function importSnippet(apiConfig: unknown) {
    const dir = mkdtempSync(join(tmpdir(), 'smrt-conditional-get-'));
    tempDirs.push(dir);
    const modulePath = join(dir, 'conditional-get-helper.ts');
    writeFileSync(
      modulePath,
      `${generateConditionalGetRouteHelper(apiConfig)}\nexport { conditionalJson, READ_CACHE_CONTROL };\n`,
    );
    return await import(pathToFileURL(modulePath).href);
  }

  it('bakes the private policy in and answers 304 on a matching If-None-Match', async () => {
    const helper = await importSnippet({ public: false });
    expect(helper.READ_CACHE_CONTROL).toBe(PRIVATE_READ_CACHE_CONTROL);

    const payload = { items: [{ id: '1' }], count: 1 };
    const first: Response = helper.conditionalJson(
      new Request('http://local/api/widgets'),
      payload,
    );
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe(PRIVATE_READ_CACHE_CONTROL);
    const etag = first.headers.get('etag');
    expect(etag).toMatch(/^"[A-Za-z0-9_-]+"$/);
    expect(await first.json()).toEqual(payload);

    // Same payload + If-None-Match → 304 with an empty body.
    const revalidated: Response = helper.conditionalJson(
      new Request('http://local/api/widgets', {
        headers: { 'if-none-match': etag as string },
      }),
      payload,
    );
    expect(revalidated.status).toBe(304);
    expect(await revalidated.text()).toBe('');
    expect(revalidated.headers.get('etag')).toBe(etag);

    // Changed payload → 200 with a NEW ETag (mutation changes the ETag).
    const changed: Response = helper.conditionalJson(
      new Request('http://local/api/widgets', {
        headers: { 'if-none-match': etag as string },
      }),
      { items: [{ id: '1', name: 'renamed' }], count: 1 },
    );
    expect(changed.status).toBe(200);
    expect(changed.headers.get('etag')).not.toBe(etag);
  });

  it('bakes the shared policy in for public models with sMaxage', async () => {
    const helper = await importSnippet({
      public: true,
      cache: { sMaxage: 120 },
    });
    expect(helper.READ_CACHE_CONTROL).toBe('public, max-age=0, s-maxage=120');

    const res: Response = helper.conditionalJson(
      new Request('http://local/api/widgets'),
      { ok: true },
    );
    expect(res.headers.get('cache-control')).toBe(
      'public, max-age=0, s-maxage=120',
    );
  });

  it('parity: the snippet ETag equals the runtime computeBodyEtag', async () => {
    const helper = await importSnippet(undefined);
    const payload = { parity: true };
    const res: Response = helper.conditionalJson(
      new Request('http://local/api/widgets'),
      payload,
    );
    expect(res.headers.get('etag')).toBe(
      computeBodyEtag(JSON.stringify(payload)),
    );
  });
});
