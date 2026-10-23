// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createBrowserAnalytics,
  createMatomoProvider,
  resolveBrowserAnalyticsConfig,
  safeRoutePath,
} from '../browser.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function setup(extra = {}) {
  const provider = { pageview: vi.fn(), event: vi.fn(), heartbeat: vi.fn() };
  const tracker = createBrowserAnalytics({
    enabled: true,
    provider,
    events: { saved: { category: 'app', action: 'saved' } },
    ...extra,
  });
  return { provider, tracker };
}
describe('browser analytics', () => {
  it('is disabled by default, development requires explicit QA, and SSR is inert', () => {
    const env = {
      PUBLIC_ANALYTICS_ENABLED: 'true',
      PUBLIC_MATOMO_URL: 'https://stats.example',
      PUBLIC_MATOMO_SITE_ID: '2',
    };
    expect(
      resolveBrowserAnalyticsConfig({}, { development: false }).enabled,
    ).toBe(false);
    expect(
      resolveBrowserAnalyticsConfig(env, { development: true }).enabled,
    ).toBe(false);
    expect(
      resolveBrowserAnalyticsConfig(
        { ...env, PUBLIC_ANALYTICS_ALLOW_DEVELOPMENT: 'true' },
        { development: true },
      ).enabled,
    ).toBe(true);
    expect(
      resolveBrowserAnalyticsConfig(
        { ...env, PUBLIC_MATOMO_URL: 'https://secret@stats.example' },
        { development: false },
      ).enabled,
    ).toBe(false);
    const disabled = setup({ enabled: false });
    expect(disabled.tracker.pageview({ url: '/' })).toBe(false);
    expect(disabled.provider.pageview).not.toHaveBeenCalled();
    const development = setup({ development: true });
    expect(development.tracker.pageview({ url: '/' })).toBe(false);
    vi.stubGlobal('window', undefined);
    const ssr = setup();
    expect(ssr.tracker.pageview({ url: '/' })).toBe(false);
  });
  it('uses sanitized explicit pages, allowlisted event definitions, and suppresses repeated views/events', () => {
    const { tracker, provider } = setup();
    expect(tracker.track('saved')).toBe(false);
    expect(
      tracker.pageview({
        url: '/projects/[id]?token=private#email',
        title: 'App',
      }),
    ).toBe(true);
    expect(provider.pageview).toHaveBeenCalledWith({
      url: `${window.location.origin}/projects/[id]`,
      title: 'App',
    });
    expect(tracker.pageview({ url: '/projects/[id]?other=secret' })).toBe(
      false,
    );
    expect(tracker.track('unknown')).toBe(false);
    expect(tracker.track('toString')).toBe(false);
    expect(tracker.track('saved')).toBe(true);
    expect(tracker.track('saved')).toBe(false);
    expect(tracker.track('saved', { dedupeKey: 'receipt-one' })).toBe(true);
    expect(tracker.track('saved', { dedupeKey: 'receipt-one' })).toBe(false);
    expect(tracker.track('saved', { dedupeKey: 'receipt-two' })).toBe(true);
    expect(provider.event.mock.calls[0][0]).toEqual({
      category: 'app',
      action: 'saved',
    });
    tracker.pageview({ url: '/other' });
    expect(tracker.track('saved')).toBe(true);
    expect(tracker.pageview({ url: 'https://elsewhere.example/private' })).toBe(
      false,
    );
    tracker.dispose();
    expect(tracker.track('saved')).toBe(false);
    expect(tracker.pageview({ url: '/' })).toBe(false);
  });
  it('contains provider rejection and heartbeat runs only visible/focused until disposal', async () => {
    vi.useFakeTimers();
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const { tracker, provider } = setup({ heartbeatSeconds: 5 });
    provider.pageview.mockRejectedValue(new Error('offline'));
    tracker.pageview({ url: '/' });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5000);
    expect(provider.heartbeat).toHaveBeenCalledTimes(1);
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(provider.heartbeat).toHaveBeenCalledTimes(1);
    tracker.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(provider.heartbeat).toHaveBeenCalledTimes(1);
  });
  it('sanitizes route IDs without accepting a raw unknown pathname', () => {
    expect(safeRoutePath('/(app)/projects/[projectId]')).toBe(
      '/projects/[projectId]',
    );
    expect(safeRoutePath('/(app)')).toBe('/');
    expect(safeRoutePath(null)).toBeNull();
  });
  it('sends only the minimal Matomo protocol, with no cookies, referrer, identity or freeform data', async () => {
    const transport = vi.fn().mockResolvedValue({});
    const provider = createMatomoProvider({
      baseUrl: 'https://stats.example/base/',
      siteId: '2',
      fetch: transport,
    });
    const page = {
      url: 'https://app.example/projects/[id]?token=secret#private',
      title: 'App',
    };
    await provider.pageview(page);
    await provider.event({ category: 'project', action: 'saved' }, page);
    await provider.heartbeat!(page);
    expect(transport.mock.calls[0][0]).toBe(
      'https://stats.example/base/matomo.php',
    );
    const request = transport.mock.calls[1][1];
    expect(request).toMatchObject({
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      mode: 'no-cors',
      keepalive: true,
    });
    expect(Object.fromEntries(request.body)).toEqual({
      idsite: '2',
      rec: '1',
      apiv: '1',
      cookie: '0',
      send_image: '0',
      url: 'https://app.example/projects/[id]',
      action_name: 'App',
      e_c: 'project',
      e_a: 'saved',
      ca: '1',
    });
    expect(transport.mock.calls[2][1].body.get('ping')).toBe('1');
    expect(() =>
      createMatomoProvider({ baseUrl: 'javascript:alert(1)', siteId: '2' }),
    ).toThrow();
    expect(() =>
      createMatomoProvider({
        baseUrl: 'https://stats.example?token=secret',
        siteId: '2',
      }),
    ).toThrow();
  });
});
