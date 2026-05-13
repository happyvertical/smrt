import { describe, expect, it } from 'vitest';
import { requestHasTrustedOrigin } from './content-chat-route-helpers';

describe('content chat route helpers', () => {
  it('rejects browser requests with no origin fallback signals', () => {
    expect(
      requestHasTrustedOrigin(
        new Request('https://example.com/api/v1/contents/1/chat', {
          method: 'POST',
        }),
      ),
    ).toBe(false);
  });

  it('accepts same-origin Origin, Sec-Fetch-Site, or Referer signals', () => {
    expect(
      requestHasTrustedOrigin(
        new Request('https://example.com/api/v1/contents/1/chat', {
          method: 'POST',
          headers: { origin: 'https://example.com' },
        }),
      ),
    ).toBe(true);

    expect(
      requestHasTrustedOrigin(
        new Request('https://example.com/api/v1/contents/1/chat', {
          method: 'POST',
          headers: { 'sec-fetch-site': 'same-origin' },
        }),
      ),
    ).toBe(true);

    expect(
      requestHasTrustedOrigin(
        new Request('https://example.com/api/v1/contents/1/chat', {
          method: 'POST',
          headers: { referer: 'https://example.com/editor' },
        }),
      ),
    ).toBe(true);
  });

  it('rejects cross-origin request signals', () => {
    expect(
      requestHasTrustedOrigin(
        new Request('https://example.com/api/v1/contents/1/chat', {
          method: 'POST',
          headers: { origin: 'https://evil.example' },
        }),
      ),
    ).toBe(false);

    expect(
      requestHasTrustedOrigin(
        new Request('https://example.com/api/v1/contents/1/chat', {
          method: 'POST',
          headers: { 'sec-fetch-site': 'cross-site' },
        }),
      ),
    ).toBe(false);

    expect(
      requestHasTrustedOrigin(
        new Request('https://example.com/api/v1/contents/1/chat', {
          method: 'POST',
          headers: { referer: 'https://evil.example/editor' },
        }),
      ),
    ).toBe(false);
  });
});
