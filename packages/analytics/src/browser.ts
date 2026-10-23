/** Browser-only analytics. No model registration, identity, storage, or implicit URLs. */
export interface AnalyticsEventDefinition {
  category: string;
  action: string;
}
export interface AnalyticsPage {
  /** A static route template or virtual page, never a user-provided path. */
  url: string;
  /** Static application title, never a record name or document.title. */
  title?: string;
}
export interface BrowserAnalyticsProvider {
  pageview(page: AnalyticsPage): void | Promise<unknown>;
  event(
    event: AnalyticsEventDefinition,
    page: AnalyticsPage,
  ): void | Promise<unknown>;
  heartbeat?(page: AnalyticsPage): void | Promise<unknown>;
}
export interface BrowserAnalyticsConfig {
  enabled: boolean;
  development?: boolean;
  allowDevelopment?: boolean;
  heartbeatSeconds?: number;
}
export const STANDARD_ANALYTICS_EVENTS = {
  planner_opened: { category: 'planner', action: 'opened' },
  planner_cookbook_applied: { category: 'planner', action: 'cookbook_applied' },
  project_question_answered: {
    category: 'project',
    action: 'question_answered',
  },
  project_decision_resolved: {
    category: 'project',
    action: 'decision_resolved',
  },
  project_preview_opened: { category: 'project', action: 'preview_opened' },
  project_preview_approved: { category: 'project', action: 'preview_approved' },
  project_preview_rejected: { category: 'project', action: 'preview_rejected' },
} as const;

/** Public environment strings only. Missing or malformed settings stay disabled. */
export function resolveBrowserAnalyticsConfig(
  env: Record<string, string | undefined>,
  { development }: { development: boolean },
) {
  const seconds = Number(env.PUBLIC_ANALYTICS_HEARTBEAT_SECONDS);
  const baseUrl = env.PUBLIC_MATOMO_URL ?? '';
  const siteId = env.PUBLIC_MATOMO_SITE_ID ?? '';
  const allowDevelopment = env.PUBLIC_ANALYTICS_ALLOW_DEVELOPMENT === 'true';
  return {
    enabled:
      env.PUBLIC_ANALYTICS_ENABLED === 'true' &&
      (!development || allowDevelopment) &&
      validEndpoint(baseUrl) !== null &&
      /^\d+$/.test(siteId) &&
      Number(siteId) > 0,
    development,
    allowDevelopment,
    baseUrl,
    siteId,
    heartbeatSeconds:
      Number.isFinite(seconds) && seconds >= 5 ? seconds : undefined,
  };
}

/** SvelteKit's route ID, never location.pathname; missing routes are excluded. */
export function safeRoutePath(routeId: string | null): string | null {
  if (!routeId || !routeId.startsWith('/')) return null;
  return routeId.replace(/\/\([^/]*\)/g, '') || '/';
}

function validEndpoint(value: string): URL | null {
  try {
    const url = new URL(value);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    return url;
  } catch {
    return null;
  }
}

/** A provider failure must never interrupt an application operation. */
function quietly(run: () => unknown) {
  try {
    Promise.resolve(run()).catch(() => {});
  } catch {
    /* no payload logging */
  }
}

export function createBrowserAnalytics(
  options: BrowserAnalyticsConfig & {
    provider: BrowserAnalyticsProvider;
    events?: Record<string, AnalyticsEventDefinition>;
  },
) {
  const active =
    options.enabled &&
    (!options.development || options.allowDevelopment) &&
    typeof window !== 'undefined';
  const definitions = new Map(
    Object.entries({ ...STANDARD_ANALYTICS_EVENTS, ...options.events }).map(
      ([key, value]) => [
        key,
        { category: value.category, action: value.action },
      ],
    ),
  );
  let disposed = false;
  let current: AnalyticsPage | undefined;
  let lastViewed: string | undefined;
  const emitted = new Set<string>();
  const permitted = () => active && !disposed;
  function context(page: AnalyticsPage): boolean {
    if (!permitted()) return false;
    try {
      const url = new URL(page.url, window.location.origin);
      if (
        !['https:', 'http:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.origin !== window.location.origin
      ) {
        current = undefined;
        return false;
      }
      url.search = '';
      url.hash = '';
      if (current?.url !== url.href) emitted.clear();
      current = { url: url.href, ...(page.title ? { title: page.title } : {}) };
      return true;
    } catch {
      current = undefined;
      return false;
    }
  }
  const seconds = options.heartbeatSeconds;
  const timer =
    active &&
    Number.isFinite(seconds) &&
    seconds! >= 5 &&
    options.provider.heartbeat
      ? setInterval(() => {
          if (
            permitted() &&
            current &&
            document.visibilityState === 'visible' &&
            document.hasFocus()
          ) {
            const page = { ...current };
            quietly(() => options.provider.heartbeat?.(page));
          }
        }, seconds! * 1000)
      : undefined;
  return {
    context,
    pageview(page: AnalyticsPage): boolean {
      if (!context(page) || current!.url === lastViewed) return false;
      lastViewed = current!.url;
      const safe = { ...current! };
      quietly(() => options.provider.pageview(safe));
      return true;
    },
    /** Static allowlist only. At most once per key and current page context. */
    track(key: string, eventOptions?: { dedupeKey?: string }): boolean {
      const definition = definitions.get(key);
      const identity = JSON.stringify([key, eventOptions?.dedupeKey ?? null]);
      if (!permitted() || !current || !definition || emitted.has(identity))
        return false;
      emitted.add(identity);
      const page = { ...current };
      quietly(() => options.provider.event({ ...definition }, page));
      return true;
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) clearInterval(timer);
      emitted.clear();
      current = undefined;
    },
  };
}

/** Matomo's free Tracking HTTP API; deliberately avoids its global JS tracker. */
export function createMatomoProvider(options: {
  baseUrl: string;
  siteId: string;
  /** Transport injection for tests; production uses browser fetch. */
  fetch?: typeof fetch;
}): BrowserAnalyticsProvider {
  const base = validEndpoint(options.baseUrl);
  if (!base || !/^\d+$/.test(options.siteId) || Number(options.siteId) <= 0)
    throw new Error('Invalid public analytics configuration');
  const endpoint = new URL(`${base.href.replace(/\/$/, '')}/matomo.php`);
  function send(page: AnalyticsPage, extra: Record<string, string> = {}) {
    const url = new URL(page.url);
    url.search = '';
    url.hash = '';
    url.username = '';
    url.password = '';
    const body = new URLSearchParams({
      idsite: options.siteId,
      rec: '1',
      apiv: '1',
      cookie: '0',
      send_image: '0',
      url: url.href,
      ...(page.title ? { action_name: page.title } : {}),
      ...extra,
    });
    return (options.fetch ?? globalThis.fetch)(endpoint.href, {
      method: 'POST',
      body,
      mode: 'no-cors',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      keepalive: true,
    });
  }
  return {
    pageview: (page) => send(page),
    event: (event, page) =>
      send(page, { e_c: event.category, e_a: event.action, ca: '1' }),
    heartbeat: (page) => send(page, { ping: '1' }),
  };
}
