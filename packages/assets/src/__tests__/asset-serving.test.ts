/**
 * asset-serving tests
 *
 * Exercises the generic serving contract end-to-end with an in-memory
 * SQLite DB and a real temp-directory asset store.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AssetRuntime, createAssetRuntime } from '../asset-runtime';
import {
  AssetServeError,
  resolveAssetForServing,
  serveAsset,
} from '../asset-serving';

describe('serveAsset', () => {
  let db: DatabaseInterface;
  let storageDir: string;
  let runtime: AssetRuntime;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    storageDir = mkdtempSync(pathJoin(tmpdir(), 'asset-serving-'));
    runtime = await createAssetRuntime({ db, storage: storageDir });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
    if (storageDir && existsSync(storageDir)) {
      rmSync(storageDir, { recursive: true, force: true });
    }
  });

  it('returns 200 with bytes, content-type, and content-disposition', async () => {
    const asset = await runtime.storeSourceAsset(
      'hello.txt',
      Buffer.from('hello'),
      { mimeType: 'text/plain', typeSlug: 'document' },
    );

    const response = await serveAsset({ runtime, asset: asset.id! });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain');
    expect(response.headers.get('content-length')).toBe('5');
    const disposition = response.headers.get('content-disposition') ?? '';
    expect(disposition.startsWith('inline;')).toBe(true);
    expect(disposition).toContain('hello.txt');

    const body = Buffer.from(await response.arrayBuffer());
    expect(body.toString()).toBe('hello');
  });

  it('uses attachment disposition when requested', async () => {
    const asset = await runtime.storeSourceAsset(
      'report.pdf',
      Buffer.from('PDF'),
      { mimeType: 'application/pdf', typeSlug: 'document' },
    );

    const response = await serveAsset({
      runtime,
      asset,
      disposition: 'attachment',
    });

    expect(response.headers.get('content-disposition')).toMatch(/^attachment;/);
  });

  it('always sets X-Content-Type-Options: nosniff on 200 responses', async () => {
    const asset = await runtime.storeSourceAsset('a.txt', Buffer.from('x'), {
      mimeType: 'text/plain',
      typeSlug: 'document',
    });

    const response = await serveAsset({ runtime, asset: asset.id! });

    expect(response.status).toBe(200);
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('forces attachment for non-safelisted (XSS-prone) mime types', async () => {
    for (const mimeType of ['text/html', 'image/svg+xml', 'application/xml']) {
      const asset = await runtime.storeSourceAsset(
        'payload',
        Buffer.from('<script>alert(1)</script>'),
        { mimeType, typeSlug: 'document' },
      );

      // Caller explicitly asks for inline; serve must downgrade to attachment.
      const response = await serveAsset({
        runtime,
        asset: asset.id!,
        disposition: 'inline',
      });

      expect(response.status).toBe(200);
      const disposition = response.headers.get('content-disposition') ?? '';
      expect(
        disposition.startsWith('attachment;'),
        `expected ${mimeType} to be forced to attachment`,
      ).toBe(true);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });

  it('keeps inline disposition for safelisted mime types', async () => {
    const asset = await runtime.storeSourceAsset('p.png', Buffer.from('PNG'), {
      mimeType: 'image/png',
      typeSlug: 'document',
    });

    const response = await serveAsset({
      runtime,
      asset: asset.id!,
      disposition: 'inline',
    });

    const disposition = response.headers.get('content-disposition') ?? '';
    expect(disposition.startsWith('inline;')).toBe(true);
  });

  it('does not let caller headers weaken forced-attachment / nosniff', async () => {
    // A non-safelisted (XSS-prone) type is force-downgraded to attachment +
    // nosniff. A caller must NOT be able to override those via options.headers
    // to coerce inline rendering (regression for S5 #1396 header-override).
    const asset = await runtime.storeSourceAsset(
      'payload.svg',
      Buffer.from('<svg onload="alert(1)"></svg>'),
      { mimeType: 'image/svg+xml', typeSlug: 'document' },
    );

    const response = await serveAsset({
      runtime,
      asset: asset.id!,
      disposition: 'inline',
      headers: {
        // Try both canonical and lowercase header names — HTTP header names
        // are case-insensitive, so the guard must reject either casing.
        'Content-Disposition': 'inline',
        'content-disposition': 'inline; filename="evil.html"',
        'X-Content-Type-Options': '',
        'content-type': 'text/html',
        // A genuinely custom header should still pass through.
        'X-Custom-Tag': 'keep-me',
      },
    });

    expect(response.status).toBe(200);
    const disposition = response.headers.get('content-disposition') ?? '';
    expect(disposition.startsWith('attachment;')).toBe(true);
    expect(disposition).not.toContain('evil.html');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    // The forced content-type wins over the caller's text/html.
    expect(response.headers.get('content-type')).toBe('image/svg+xml');
    // Non-protected custom headers are preserved.
    expect(response.headers.get('x-custom-tag')).toBe('keep-me');
  });

  it('returns 404 when the asset id does not resolve', async () => {
    const response = await serveAsset({ runtime, asset: 'missing-id' });
    expect(response.status).toBe(404);
  });

  it('returns 403 when tenantId mismatches', async () => {
    const asset = await runtime.storeSourceAsset(
      'secret.txt',
      Buffer.from('secret'),
      { mimeType: 'text/plain', typeSlug: 'document' },
    );
    asset.tenantId = 'tenant-a';
    await asset.save();

    const response = await serveAsset({
      runtime,
      asset: asset.id!,
      tenantId: 'tenant-b',
    });

    expect(response.status).toBe(403);
  });

  it('allows global (tenantId=null) assets through a tenant check', async () => {
    const asset = await runtime.storeSourceAsset(
      'public.txt',
      Buffer.from('pub'),
      { mimeType: 'text/plain', typeSlug: 'document' },
    );

    const response = await serveAsset({
      runtime,
      asset: asset.id!,
      tenantId: 'tenant-a',
    });

    expect(response.status).toBe(200);
  });

  it('runs the custom canAccess hook after tenant checks', async () => {
    const asset = await runtime.storeSourceAsset(
      'guarded.txt',
      Buffer.from('x'),
      { mimeType: 'text/plain', typeSlug: 'document' },
    );

    const response = await serveAsset({
      runtime,
      asset: asset.id!,
      canAccess: () => false,
    });

    expect(response.status).toBe(403);
  });

  it('does not leak underlying error details in the 500 body', async () => {
    const asset = await runtime.storeSourceAsset(
      'broken.txt',
      Buffer.from('bytes'),
      { mimeType: 'text/plain', typeSlug: 'document' },
    );
    asset.sourceUri = 'file:///definitely/not/real/absolute-path.txt';
    await asset.save();

    const response = await serveAsset({ runtime, asset: asset.id! });

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toBe('Failed to read asset bytes');
    expect(body).not.toContain('absolute-path');
  });

  it('sanitises control characters out of Content-Disposition', async () => {
    const asset = await runtime.storeSourceAsset(
      'bad\r\nname.txt',
      Buffer.from('x'),
      { mimeType: 'text/plain', typeSlug: 'document' },
    );

    const response = await serveAsset({ runtime, asset: asset.id! });

    expect(response.status).toBe(200);
    const disposition = response.headers.get('content-disposition') ?? '';
    // The critical property: no raw control characters (prevents
    // CRLF header injection and Response-constructor errors).
    const hasControl = [...disposition].some((ch) => {
      const code = ch.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    });
    expect(hasControl).toBe(false);
    // The trailing text and extension should survive sanitisation.
    expect(disposition).toContain('badname.txt');
  });

  it('replaces quotes and path separators in filename', async () => {
    const asset = await runtime.storeSourceAsset(
      'normal.txt',
      Buffer.from('x'),
      { mimeType: 'text/plain', typeSlug: 'document' },
    );

    const response = await serveAsset({
      runtime,
      asset: asset.id!,
      filename: 'a"weird\\/name.txt',
    });

    expect(response.status).toBe(200);
    const disposition = response.headers.get('content-disposition') ?? '';
    expect(disposition).toContain('filename="a_weird__name.txt"');
    expect(disposition).not.toMatch(/filename="[^"]*["\\/][^"]*"/);
  });

  describe('remote sourceUri handling', () => {
    it('treats a remote sourceUri as an error by default (no implicit proxy)', async () => {
      const asset = await runtime.storeSourceAsset(
        'manifest.json',
        Buffer.from('ignored local'),
        { mimeType: 'application/json', typeSlug: 'document' },
      );
      asset.sourceUri = 'https://example.com/docs/manifest.json';
      await asset.save();

      let fetched = false;
      const fetchImpl: typeof fetch = async () => {
        fetched = true;
        return new Response('should not be called', { status: 200 });
      };

      const response = await serveAsset({
        runtime,
        asset: asset.id!,
        fetchImpl,
      });

      // Default is 'error' — no fetch should happen and a remote URI is a 500.
      expect(fetched).toBe(false);
      expect(response.status).toBe(500);
    });

    it('proxies bytes from a public http(s) origin when remoteMode is proxy', async () => {
      const asset = await runtime.storeSourceAsset(
        'manifest.json',
        Buffer.from('ignored local'),
        { mimeType: 'application/json', typeSlug: 'document' },
      );
      asset.sourceUri = 'https://example.com/docs/manifest.json';
      await asset.save();

      const calls: string[] = [];
      const fetchImpl: typeof fetch = async (input) => {
        calls.push(String(input));
        return new Response(
          Buffer.from('REMOTE BYTES') as unknown as BodyInit,
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
          },
        );
      };

      const response = await serveAsset({
        runtime,
        asset: asset.id!,
        remoteMode: 'proxy',
        fetchImpl,
      });

      expect(calls).toEqual(['https://example.com/docs/manifest.json']);
      expect(response.status).toBe(200);
      const body = Buffer.from(await response.arrayBuffer());
      expect(body.toString()).toBe('REMOTE BYTES');
    });

    it('blocks SSRF to private / loopback / link-local / metadata hosts', async () => {
      const blocked = [
        'http://169.254.169.254/latest/meta-data/',
        'http://127.0.0.1/secret',
        'http://localhost:8080/internal',
        'http://10.0.0.5/admin',
        'http://192.168.1.1/router',
        'http://172.16.0.10/svc',
        'http://[::1]/loopback',
        'http://metadata.google.internal/computeMetadata/v1/',
        // IPv4-mapped IPv6: Node normalises the dotted form to the hex
        // `::ffff:7f00:1` / `::ffff:a9fe:a9fe`, so the guard must decode the
        // embedded v4 from BOTH forms (regression for S5 #1396 IPv6 bypass).
        'http://[::ffff:127.0.0.1]/secret',
        'http://[::ffff:7f00:1]/secret',
        'http://[::ffff:169.254.169.254]/meta',
        // Link-local is fe80::/10 (fe80–febf), not just the fe80 prefix.
        'http://[fe90::1]/internal',
        'http://[febf::1]/internal',
        // Unique-local fc00::/7 and multicast ff00::/8.
        'http://[fc00::1]/internal',
        'http://[ff02::1]/internal',
        // Trailing-dot FQDNs resolve to the same loopback/metadata hosts but
        // dodge the exact-match checks unless the terminal dot is stripped.
        'http://localhost./internal',
        'http://metadata.google.internal./computeMetadata/v1/',
      ];

      for (const uri of blocked) {
        const asset = await runtime.storeSourceAsset(
          'x.bin',
          Buffer.from('local'),
          { mimeType: 'application/octet-stream', typeSlug: 'document' },
        );
        asset.sourceUri = uri;
        await asset.save();

        let fetched = false;
        const fetchImpl: typeof fetch = async () => {
          fetched = true;
          return new Response('SHOULD NOT REACH', { status: 200 });
        };

        const response = await serveAsset({
          runtime,
          asset: asset.id!,
          remoteMode: 'proxy',
          fetchImpl,
        });

        // Never reaches the network, and the status is opaque (502).
        expect(fetched, `expected ${uri} to be blocked before fetch`).toBe(
          false,
        );
        expect(response.status, `expected ${uri} to be rejected`).toBe(502);
      }
    });

    it('still proxies public IPv6 / mapped-public hosts (no over-blocking)', async () => {
      // Structural IPv6 parsing must not false-positive on genuinely public
      // addresses: a global-unicast v6 and an IPv4-mapped public address.
      const allowed = [
        'http://[2606:4700:4700::1111]/ok', // Cloudflare DNS (public)
        'http://[::ffff:8.8.8.8]/ok', // mapped 8.8.8.8 (public)
      ];

      for (const uri of allowed) {
        const asset = await runtime.storeSourceAsset(
          'x.bin',
          Buffer.from('local'),
          { mimeType: 'application/octet-stream', typeSlug: 'document' },
        );
        asset.sourceUri = uri;
        await asset.save();

        let fetched = false;
        const fetchImpl: typeof fetch = async () => {
          fetched = true;
          return new Response(Buffer.from('OK') as unknown as BodyInit, {
            status: 200,
            headers: { 'content-type': 'application/octet-stream' },
          });
        };

        const response = await serveAsset({
          runtime,
          asset: asset.id!,
          remoteMode: 'proxy',
          fetchImpl,
        });

        expect(fetched, `expected ${uri} to be allowed through`).toBe(true);
        expect(response.status, `expected ${uri} to be served`).toBe(200);
      }
    });

    it('rejects non-http(s) schemes on the proxy path', async () => {
      const asset = await runtime.storeSourceAsset(
        'x.bin',
        Buffer.from('local'),
        { mimeType: 'application/octet-stream', typeSlug: 'document' },
      );
      // isRemoteUri only matches http(s); use a host that LOOKS remote but
      // carries a dangerous scheme by going through the redirect re-validation.
      asset.sourceUri = 'https://example.com/start';
      await asset.save();

      const fetchImpl: typeof fetch = async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'file:///etc/passwd' },
        });

      const response = await serveAsset({
        runtime,
        asset: asset.id!,
        remoteMode: 'proxy',
        fetchImpl,
      });

      // Redirect to a file:// scheme must be rejected.
      expect(response.status).toBe(502);
    });

    it('re-validates redirects against the SSRF guard', async () => {
      const asset = await runtime.storeSourceAsset(
        'x.bin',
        Buffer.from('local'),
        { mimeType: 'application/octet-stream', typeSlug: 'document' },
      );
      asset.sourceUri = 'https://example.com/start';
      await asset.save();

      const fetchImpl: typeof fetch = async () =>
        // Public host 302s to cloud metadata — classic SSRF redirect bypass.
        new Response(null, {
          status: 302,
          headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        });

      const response = await serveAsset({
        runtime,
        asset: asset.id!,
        remoteMode: 'proxy',
        fetchImpl,
      });

      expect(response.status).toBe(502);
    });

    it('caps the proxied body size to prevent memory-exhaustion DoS', async () => {
      const asset = await runtime.storeSourceAsset(
        'big.bin',
        Buffer.from('local'),
        { mimeType: 'application/octet-stream', typeSlug: 'document' },
      );
      asset.sourceUri = 'https://example.com/big.bin';
      await asset.save();

      // Stream more bytes than the cap allows.
      const oversized = Buffer.alloc(2048, 0x41);
      const fetchImpl: typeof fetch = async () =>
        new Response(oversized as unknown as BodyInit, { status: 200 });

      const response = await serveAsset({
        runtime,
        asset: asset.id!,
        remoteMode: 'proxy',
        remoteMaxBytes: 1024,
        fetchImpl,
      });

      expect(response.status).toBe(502);
    });

    it('returns 302 Location when remoteMode is redirect', async () => {
      const asset = await runtime.storeSourceAsset(
        'doc.pdf',
        Buffer.from('ignored'),
        { mimeType: 'application/pdf', typeSlug: 'document' },
      );
      asset.sourceUri = 'https://example.com/agenda.pdf';
      await asset.save();

      const response = await serveAsset({
        runtime,
        asset: asset.id!,
        remoteMode: 'redirect',
      });

      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe(
        'https://example.com/agenda.pdf',
      );
    });

    it('returns 502 when the proxied fetch fails', async () => {
      const asset = await runtime.storeSourceAsset(
        'bad.json',
        Buffer.from('ignored'),
        { mimeType: 'application/json', typeSlug: 'document' },
      );
      asset.sourceUri = 'https://example.com/missing.json';
      await asset.save();

      const fetchImpl: typeof fetch = async () =>
        new Response('', { status: 404 });

      const response = await serveAsset({
        runtime,
        asset: asset.id!,
        remoteMode: 'proxy',
        fetchImpl,
      });

      expect(response.status).toBe(502);
    });

    it('treats remote URIs as errors when remoteMode is error', async () => {
      const asset = await runtime.storeSourceAsset(
        'whatever.bin',
        Buffer.from('ignored'),
        { mimeType: 'application/octet-stream', typeSlug: 'document' },
      );
      asset.sourceUri = 'https://example.com/thing.bin';
      await asset.save();

      const response = await serveAsset({
        runtime,
        asset: asset.id!,
        remoteMode: 'error',
      });

      expect(response.status).toBe(500);
    });
  });

  describe('resolveAssetForServing', () => {
    it('throws AssetServeError(404) for unknown ids', async () => {
      await expect(
        resolveAssetForServing({ runtime, asset: 'nope' }),
      ).rejects.toMatchObject({
        name: 'AssetServeError',
        status: 404,
      });
    });

    it('returns bytes + metadata for authorised callers', async () => {
      const asset = await runtime.storeSourceAsset(
        'ok.txt',
        Buffer.from('ok'),
        { mimeType: 'text/plain', typeSlug: 'document' },
      );

      const resolved = await resolveAssetForServing({
        runtime,
        asset: asset.id!,
      });

      expect(resolved.asset.id).toBe(asset.id);
      expect(resolved.data.toString()).toBe('ok');
      expect(resolved.contentType).toBe('text/plain');
      expect(resolved.size).toBe(2);
    });

    it('surfaces 500 errors from the store as AssetServeError', async () => {
      const asset = await runtime.storeSourceAsset(
        'broken.txt',
        Buffer.from('bytes'),
        { mimeType: 'text/plain', typeSlug: 'document' },
      );
      // Force the store to fail by pointing at a missing file
      asset.sourceUri = 'file:///definitely/not/real/path.txt';
      await asset.save();

      await expect(
        resolveAssetForServing({ runtime, asset: asset.id! }),
      ).rejects.toBeInstanceOf(AssetServeError);
    });
  });
});
