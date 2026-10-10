# @happyvertical/smrt-webhooks

Server-only outbound webhooks. `change-feed.ts` owns durable model publication
with tenant/runtime cursors and retained-history recovery; `events.ts` is the
optional non-atomic hook path. Never enable both for the same models. `store.ts` owns tenant-bound SQL and atomic
outbox/job enqueue; `dispatcher.ts` owns signing and job execution. Always use
`requireTenant()` plus explicit tenant predicates, including raw CAS writes.

`security.ts` validates every DNS result, pins HTTPS lookup, disables pooling,
and bounds DNS/request time. Never substitute a preflight DNS check followed by
fetch, follow redirects, or persist raw transport errors. Preserve exact stored
payload bytes for signing. HTTP is at-least-once; receivers deduplicate the
stable delivery ID. Do not promise exactly-once network effects.

Admin projections are allowlists. Secrets and payloads are sensitive fields;
generated API/CLI/MCP access is disabled. The host authorizes administrators via
`WebhookAdminService`; Svelte callbacks must use authenticated, CSRF-protected
host routes. No credentials in the browser read model.

Validate: `pnpm test`, `pnpm typecheck`, `pnpm check`, `pnpm test:e2e` within this
package after building its dependencies. E2E uses the maintained Playwright
harness under `e2e/`; no external webhook server or network credential is needed.
See README.md for migration, lifecycle-hook boundaries and worker setup.
