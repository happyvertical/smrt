import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: mocks.lookup }));
vi.mock('node:https', () => ({ request: mocks.request }));

import {
  assertHmacSecret,
  assertWebhookUrl,
  isPublicAddress,
  sendPublicWebhook,
} from '../security.js';

beforeEach(() => {
  mocks.lookup.mockReset();
  mocks.request.mockReset();
});
describe('public outbound transport boundary', () => {
  it('rejects literal reserved, mapped, private, transition, and invalid targets', () => {
    for (const ip of [
      '0.0.0.0',
      '10.0.0.1',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.1.1',
      '192.168.1.1',
      '192.0.2.1',
      '198.18.0.1',
      '198.51.100.1',
      '203.0.113.1',
      '224.0.0.1',
      '255.255.255.255',
      '::',
      '::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      'fe80::1',
      'fd00::1',
      '2001:db8::1',
      '2002:7f00:1::',
      '3fff::1',
    ])
      expect(isPublicAddress(ip), ip).toBe(false);
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
    for (const url of [
      'http://example.com',
      'https://user:secret@example.com',
      'https://example.com:8443',
      'https://127.1',
      'https://[::ffff:127.0.0.1]',
      'https://example.com/#fragment',
      'https://localhost',
    ])
      expect(() => assertWebhookUrl(url)).toThrow();
    expect(() => assertHmacSecret('short')).toThrow();
  });
  it('rejects mixed DNS answers without opening a socket (including private IPv6)', async () => {
    for (const address of ['10.2.3.4', '::ffff:10.1.1.1', 'fe80::1']) {
      mocks.lookup.mockResolvedValue([
        { address: '8.8.8.8', family: 4 },
        { address, family: address.includes(':') ? 6 : 4 },
      ]);
      await expect(
        sendPublicWebhook({
          url: 'https://partner.example',
          body: '{}',
          headers: {},
        }),
      ).rejects.toThrow('not public');
    }
    expect(mocks.request).not.toHaveBeenCalled();
  });
  it('pins the validated address and preserves TLS hostname, exact bytes, no pooling and no redirects', async () => {
    mocks.lookup.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]);
    // Any re-resolution would now return a private address.
    mocks.lookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
    let bytes = '';
    mocks.request.mockImplementation((url, options, callback) => {
      expect(url.hostname).toBe('partner.example');
      expect(options.agent).toBe(false);
      const pinned = vi.fn();
      options.lookup('partner.example', { all: true }, pinned);
      expect(pinned).toHaveBeenCalledWith(null, [
        { address: '8.8.8.8', family: 4 },
      ]);
      const req = new EventEmitter() as EventEmitter & {
        end: (body: string) => void;
      };
      req.end = (body) => {
        bytes = body;
        callback({ statusCode: 302, destroy: vi.fn() });
        req.emit('close');
      };
      return req;
    });
    const body = '{"unicode":"é"}';
    expect(
      await sendPublicWebhook({
        url: 'https://partner.example/path',
        body,
        headers: {},
      }),
    ).toBe(302);
    expect(bytes).toBe(body);
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });
  it('bounds DNS and stalled HTTPS requests and redacts socket errors', async () => {
    vi.useFakeTimers();
    try {
      mocks.lookup.mockReturnValue(new Promise(() => {}));
      const dns = expect(
        sendPublicWebhook({
          url: 'https://partner.example',
          body: '{}',
          headers: {},
        }),
      ).rejects.toThrow('DNS timeout');
      await vi.advanceTimersByTimeAsync(5000);
      await dns;
      expect(mocks.request).not.toHaveBeenCalled();
      mocks.lookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
      mocks.request.mockImplementation(() => {
        const req = new EventEmitter() as EventEmitter & {
          end: () => void;
          destroy: () => void;
        };
        req.end = () => {};
        req.destroy = () => {
          req.emit('error', new Error('secret endpoint response'));
          req.emit('close');
        };
        return req;
      });
      const stalled = expect(
        sendPublicWebhook({
          url: 'https://partner.example',
          body: '{}',
          headers: {},
        }),
      ).rejects.toThrow('Webhook transport failed.');
      await vi.advanceTimersByTimeAsync(10000);
      await stalled;
    } finally {
      vi.useRealTimers();
    }
  });
});
