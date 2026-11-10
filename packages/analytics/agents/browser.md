# Browser analytics (#4251)

`@happyvertical/smrt-analytics/browser` is an isolated browser entry, without
model registration or server SDK imports. SDK analytics already owns server
Matomo reporting/tracking/admin; its Node transport is not browser-compatible.
This adapter uses Matomo's free Tracking HTTP API:
https://developer.matomo.org/api-reference/tracking-api

Hosts install `setAnalyticsContext(name => tracker?.track(name))` from
`@happyvertical/smrt-ui/analytics` during root component initialization, then
create/dispose a tracker on browser mount/config changes. Standard events are
allowlisted by default; apps add only business-specific static definitions.
`STANDARD_ANALYTICS_EVENTS` is also exported for inspection.
Components have no Matomo dependency and absent context is a noop. Configure
`PUBLIC_ANALYTICS_ENABLED=true`, `PUBLIC_MATOMO_URL`, `PUBLIC_MATOMO_SITE_ID`.
Development additionally requires `PUBLIC_ANALYTICS_ALLOW_DEVELOPMENT=true`.
Optional `PUBLIC_ANALYTICS_HEARTBEAT_SECONDS` (minimum 5) sends a Matomo ping
only while the document is visible/focused. No background/unload listeners.

On SvelteKit afterNavigate, use `safeRoutePath(page.route.id)` (null excludes
unknown routes), combine with origin and a static title, then `pageview`.
Do not pass location.pathname for dynamic routes. Queries/fragments are always
removed. Virtual pages and iframe event-only `context({url,title})` are supported.
No browser location URL, referrer or document title is read implicitly.

Shared events: Planner opened and successful explicit cookbook application;
project question open→answered and decision open→decided; preview link open
(engagement), pending→approved/rejected (persisted props). Initial historical
rows and unchanged/error/cancelled results never count as conversions. Planner
hydration does not count as applying a cookbook. Apps must update authoritative
props after their saves and must not emit these events again. No shared
invitation acceptance UI exists, so this slice cannot claim that server outcome.
No server-side conversion retry/attribution or exact-once persistence is promised.

Views dedupe consecutive sanitized URLs; events dedupe per static key and page
context. Counts therefore measure a successful outcome per view, not total
transactions. Business outcomes can pass `track(key, {dedupeKey: receiptId})`
for distinct confirmed submissions; this key stays in memory and never enters
the provider payload. Failed transport is best effort without retries/logging, and
no-cors responses cannot prove Matomo acceptance. Actual collector receipt is a
separate integration check. Network requests carry no cookie, HTTP referrer,
visitor ID, private data, dimensions, query, token, chat, email or freeform input.
The server naturally receives IP/User-Agent headers; configure Matomo retention
and IP anonymization at the deployment boundary. No unique visitor accuracy is
promised without an identifier. CSP connect-src must allow the configured host.

## Behavior-to-test matrix

All rows: actor browser visitor; executor N/A (no persistence/transactions);
SQL dialect N/A (no database); runtime browser and inert SSR.

| Invariant | Trigger / positive | Negative | Edge / level / command |
|---|---|---|---|
| Config gating | explicit production enable | missing, malformed, dev, SSR | env public strings; unit; analytics browser.test.ts |
| Privacy/navigation | template page + static allowlist | query/hash, unknown key/cross-origin | provider seam; unit; analytics browser.test.ts |
| Lifecycle/dedupe | new SPA route + success | repeated route/key, disposed | timer/provider errors; unit; analytics browser.test.ts |
| Engagement | visible focused interval | hidden/unfocused/disposed | timer; unit; analytics browser.test.ts |
| Matomo protocol | view/event/ping | invalid endpoint/site | fetch minimal payload/failure; unit; analytics browser.test.ts |
| Auto shared outcomes | observed persisted transition | historical, unchanged/failure, rerender | context + component; ui analytics and projects UI tests |
| Planner success | explicit applied signal | hydration, failed commands, unmounted | state + lifecycle; planner tests |

Focused validation uses package `exec vitest run` with the named tests; build
smrt-ui first, then analytics/projects/planner; verify package exports afterward.
This is a new feature; base bug reproduction N/A.
