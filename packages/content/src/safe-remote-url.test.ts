import { describe, expect, it, vi } from 'vitest';
import {
  assertSafeRemoteUrl,
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
      '224.0.0.1',
    ]) {
      expect(isBlockedIPv4(blocked)).toBe(true);
    }
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
    const url = await assertSafeRemoteUrl('http://127.0.0.1:8080/feed', {
      allowPrivateNetworkHosts: true,
    });
    expect(url.hostname).toBe('127.0.0.1');
  });
});
