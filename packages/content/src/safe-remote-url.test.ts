import { describe, expect, it, vi } from 'vitest';
import {
  assertSafeRemoteUrl,
  fetchSafeRemoteUrl,
  fetchSafeRemoteUrlInternal,
  isBlockedAddress,
  isBlockedIPv4,
  isBlockedIPv6,
} from './safe-remote-url';

describe('safe-remote-url SSRF guard', () => {
  it('blocks private, loopback, link-local, CGNAT, and multicast IPv4', () => {
    for (const blocked of [
      '0.0.0.0',
      '10.1.2.3',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '100.64.0.1',
      '198.18.0.1',
      '192.0.2.1',
      '198.51.100.1',
      '203.0.113.1',
      '224.0.0.1',
    ]) {
      expect(isBlockedIPv4(blocked)).toBe(true);
    }
  });

  it('rejects special-purpose ranges without rejecting neighbouring public IPv4', () => {
    for (const address of [
      '192.0.0.8',
      '192.88.99.2',
      '198.51.100.1',
      '203.0.113.1',
    ]) {
      expect(isBlockedIPv4(address), address).toBe(true);
    }
    for (const address of ['192.0.3.1', '198.51.99.1', '203.0.114.1']) {
      expect(isBlockedIPv4(address), address).toBe(false);
    }
    for (const address of [
      '64:ff9b::a00:1',
      '64:ff9b:1::1',
      '100::1',
      '100:0:0:1::1',
      '2001:2::1',
      '2001:10::1',
      '2001:db8::1',
      '2001:0db8:0:0:0:0:0:1',
      '2002:a00:1::1',
      '3fff::1',
      '5f00::1',
      'fee0::1',
    ]) {
      expect(isBlockedIPv6(address), address).toBe(true);
    }
  });

  it('rejects mixed DNS answers and resolver failures before requesting', async () => {
    const fetchImpl = vi.fn();
    for (const answers of [
      [],
      [{ address: '93.184.216.34' }, { address: '10.0.0.1' }],
    ]) {
      await expect(
        fetchSafeRemoteUrlInternal('https://example.test/', {
          fetchImpl,
          resolveHostname: async () => answers,
        }),
      ).rejects.toThrow();
    }
    await expect(
      fetchSafeRemoteUrlInternal('https://example.test/', {
        fetchImpl,
        resolveHostname: async () => {
          throw new Error('DNS unavailable');
        },
      }),
    ).rejects.toThrow('DNS unavailable');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('allows ordinary public IPv4', () => {
    expect(isBlockedIPv4('93.184.216.34')).toBe(false);
    expect(isBlockedIPv4('8.8.8.8')).toBe(false);
  });

  it('treats malformed IPv4 as blocked', () => {
    expect(isBlockedIPv4('1.2.3')).toBe(true); // wrong octet count
    expect(isBlockedIPv4('a.b.c.d')).toBe(true); // non-numeric
    expect(isBlockedIPv4('1..2.3')).toBe(true); // empty octet (review #1562)
    expect(isBlockedIPv4('1.2.3.999')).toBe(true); // out of range
    expect(isBlockedIPv4('1.2.3.04')).toBe(false); // valid (4) still allowed
  });

  it('blocks IPv4-mapped IPv6 loopback/private in every encoding (review #1562)', () => {
    // 127.0.0.1 in dotted, hex-compressed, and fully-expanded forms.
    expect(isBlockedIPv6('::ffff:127.0.0.1')).toBe(true);
    expect(isBlockedIPv6('::ffff:7f00:1')).toBe(true);
    expect(isBlockedIPv6('0:0:0:0:0:ffff:7f00:1')).toBe(true);
    expect(isBlockedIPv6('::ffff:0a00:0005')).toBe(true); // 10.0.0.5
    expect(isBlockedIPv6('::ffff:a9fe:a9fe')).toBe(true); // 169.254.169.254
    expect(isBlockedIPv6('0:0:0:0:0:ffff:a9fe:a9fe')).toBe(true); // expanded metadata
    // IPv4-compatible (deprecated) form ::127.0.0.1 also decodes to loopback.
    expect(isBlockedIPv6('::7f00:1')).toBe(true);
    // A mapped PUBLIC IPv4 (8.8.8.8 === ::ffff:0808:0808) stays allowed.
    expect(isBlockedIPv6('::ffff:0808:0808')).toBe(false);
    expect(isBlockedIPv6('::ffff:8.8.8.8')).toBe(false);
    // A genuine public IPv6 stays allowed.
    expect(isBlockedIPv6('2606:4700:4700::1111')).toBe(false);
  });

  it('blocks loopback/ULA/link-local/multicast and IPv4-mapped IPv6', () => {
    for (const blocked of [
      '::1',
      '::',
      'fc00::1',
      'fd12::3',
      'fe80::1',
      'ff02::1',
      'fec0::1',
      '2001:db8::1',
      '::ffff:127.0.0.1',
    ]) {
      expect(isBlockedIPv6(blocked)).toBe(true);
    }
    expect(isBlockedIPv6('2606:4700:4700::1111')).toBe(false);
  });

  it('blocks non-IP-literal addresses defensively', () => {
    expect(isBlockedAddress('not-an-ip')).toBe(true);
  });

  it('rejects non-http(s) schemes', async () => {
    await expect(assertSafeRemoteUrl('file:///etc/passwd')).rejects.toThrow(
      'http or https',
    );
    await expect(assertSafeRemoteUrl('ftp://example.com')).rejects.toThrow(
      'http or https',
    );
  });

  it('rejects URLs with embedded credentials', async () => {
    await expect(
      assertSafeRemoteUrl('https://user:pass@example.com', {
        resolveHostname: async () => [{ address: '93.184.216.34' }],
      }),
    ).rejects.toThrow('credentials');
  });

  it('rejects hostnames that resolve to private addresses', async () => {
    await expect(
      assertSafeRemoteUrl('https://internal.example', {
        resolveHostname: async () => [{ address: '10.0.0.1', family: 4 }],
      }),
    ).rejects.toThrow('public network address');
  });

  it('blocks literal loopback/metadata IPs without resolving DNS', async () => {
    const resolveHostname = vi.fn();
    await expect(
      assertSafeRemoteUrl('http://169.254.169.254/', { resolveHostname }),
    ).rejects.toThrow('public network address');
    expect(resolveHostname).not.toHaveBeenCalled();
  });

  it('allows public hosts', async () => {
    const url = await assertSafeRemoteUrl('https://example.com/feed', {
      resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
    });
    expect(url.hostname).toBe('example.com');
  });

  it('honours allowPrivateNetworkHosts for trusted callers', async () => {
    const resolveHostname = vi.fn();
    const url = await assertSafeRemoteUrl('http://127.0.0.1:8080/feed', {
      allowPrivateNetworkHosts: true,
      resolveHostname,
    });
    expect(url.hostname).toBe('127.0.0.1');
    expect(resolveHostname).not.toHaveBeenCalled();
  });

  it('returns a bounded conditional response with status and headers', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(null, { status: 304, headers: { etag: '"current"' } }),
    );

    const result = await fetchSafeRemoteUrlInternal(
      'https://feed.example.test/',
      {
        fetchImpl,
        headers: { 'If-None-Match': '"old"' },
        resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
      },
    );

    expect(result).toMatchObject({
      status: 304,
      headers: { etag: '"current"' },
    });
    expect(result.body).toEqual(new Uint8Array());
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL('https://feed.example.test/'),
      expect.objectContaining({
        headers: { 'If-None-Match': '"old"' },
        redirect: 'manual',
      }),
    );
  });

  it('revalidates each redirect target before requesting it', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1/internal' },
      }),
    );

    await expect(
      fetchSafeRemoteUrlInternal('https://feed.example.test/', {
        fetchImpl,
        resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
      }),
    ).rejects.toThrow('public network address');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not forward credential headers across origins', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://mirror.example.test/feed' },
        }),
      )
      .mockResolvedValueOnce(new Response('ok'));

    await fetchSafeRemoteUrlInternal('https://feed.example.test/', {
      fetchImpl,
      headers: {
        Authorization: 'Bearer secret',
        Cookie: 'session=secret',
        'X-Request-Id': 'request-1',
      },
      resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
    });

    expect(fetchImpl.mock.calls[1][1]).toMatchObject({
      headers: { 'X-Request-Id': 'request-1' },
    });
    expect(fetchImpl.mock.calls[1][1]?.headers).not.toHaveProperty(
      'Authorization',
    );
    expect(fetchImpl.mock.calls[1][1]?.headers).not.toHaveProperty('Cookie');
  });

  it('fails closed for malformed redirects, upstream errors, and declared oversized bodies', async () => {
    const resolveHostname = async () => [
      { address: '93.184.216.34', family: 4 },
    ];
    for (const response of [
      new Response(null, { status: 302 }),
      new Response(null, {
        status: 302,
        headers: { location: 'https://other.example/' },
      }),
      new Response('small', { headers: { 'content-length': '100' } }),
    ]) {
      await expect(
        fetchSafeRemoteUrlInternal('https://example.test/', {
          resolveHostname,
          fetchImpl: async () => response,
          maxRedirects: 0,
          maxBytes: 5,
        }),
      ).rejects.toThrow();
    }
    await expect(
      fetchSafeRemoteUrlInternal('https://example.test/', {
        resolveHostname,
        fetchImpl: async () => {
          throw new Error('upstream unavailable');
        },
      }),
    ).rejects.toThrow('upstream unavailable');
    const result = await fetchSafeRemoteUrlInternal('https://example.test/', {
      resolveHostname,
      fetchImpl: async () => new Response('error', { status: 503 }),
    });
    expect(result.status).toBe(503);
    expect(result.ok).toBe(false);
  });

  it('bounds DNS, streamed bodies, and HTTPS-only public calls', async () => {
    await expect(
      fetchSafeRemoteUrlInternal('https://slow.example.test/', {
        timeoutMs: 10,
        resolveHostname: async () => new Promise(() => {}),
      }),
    ).rejects.toThrow('timed out');

    await expect(
      fetchSafeRemoteUrlInternal('https://large.example.test/', {
        fetchImpl: async () => new Response('12345'),
        maxBytes: 4,
        resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
      }),
    ).rejects.toThrow('exceeds 4 bytes');

    await expect(
      fetchSafeRemoteUrl('http://example.test/', {
        resolveHostname: async () => [{ address: '93.184.216.34', family: 4 }],
      }),
    ).rejects.toThrow('must use https');

    await expect(
      fetchSafeRemoteUrl('https://example.test/', { timeoutMs: 0 }),
    ).rejects.toThrow('greater than zero');

    await expect(
      fetchSafeRemoteUrl('https://example.test/', {
        headers: { 'X-Api-Key': 'secret' },
      }),
    ).rejects.toThrow('does not allow request header');
  });
});
