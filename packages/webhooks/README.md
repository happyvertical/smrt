# Outbound webhooks

`@happyvertical/smrt-webhooks` delivers tenant-scoped create, update, delete and
custom events to public HTTPS endpoints, with an HMAC signature, a durable jobs
queue, retry/backoff, and a safe delivery log.

## Server setup

Migrate the package models and jobs system tables with the normal application
migration flow before starting workers. Runtime code never creates application
schema. Run this only in a Node server; import the UI from `/svelte` separately.

```ts
import {
  WebhookDispatcher, WebhookAdminService,
  registerWebhookRuntime, WebhookChangeFeed,
} from '@happyvertical/smrt-webhooks';
import { TaskRunner } from '@happyvertical/smrt-jobs';

const webhooks = new WebhookDispatcher({ db, runtime: 'application-webhooks' });
registerWebhookRuntime('application-webhooks', webhooks);
const events = new WebhookChangeFeed(webhooks, { orders: '@example/app:Order' });
// Poll from a host scheduler inside each authenticated tenant context.
await events.poll();
const admin = new WebhookAdminService(webhooks.store, async () =>
  currentUserHasPermission('webhooks:admin'));
const runner = new TaskRunner({ queues: ['webhooks'] });
await runner.initialize(db);
await runner.start();
```

Register the same runtime name in every worker process before starting jobs.
The runner restores captured tenant context; all service calls require the
host's authenticated `withTenant` context. Do not derive that context from a
client-supplied tenant ID. Unregister optional hooks and call `unregisterWebhookRuntime()` on shutdown. The server entry is intentionally not browser-safe.

Lifecycle subscriptions use qualified model names. The recommended durable path is
`WebhookChangeFeed`: map physical application tables to model names and poll in
each tenant context. It reads SMRT's committed change feed (including delete
tombstones), publishes identity-only `{ id }` payloads, and advances a persisted
tenant/runtime cursor only after outbox/jobs are durable. Partial failure or
process death before cursor advancement replays stable change-sequence IDs,
which deduplicate against already enqueued deliveries. Global records and other
tenants are excluded. Shared STI tables must map to their base model: the feed
does not encode a child discriminator. Custom SQL that bypasses SMRT persistence
must explicitly append its domain event or core change-feed entry.

Poll more frequently than core change-feed retention. A pruned cursor raises
`WebhookHistoryExpiredError` and stops rather than silently dropping history.
After an operator reconciles source state and publishes any recoverable missing
events, call `resumeAfterResync(error.resumeCursor)`. Lost historical transitions
cannot be reconstructed from a current-state snapshot alone; retain domain event
history if that guarantee is required. Keep one stable model mapping per runtime;
adding tables after its cursor has advanced does not backfill their older events.

`registerWebhookModelEvents` is an alternative low-latency hook binding with an
explicit model allowlist. It also publishes only identities, but source writes
and hooks are not atomic: a crash between source commit and hook enqueue can
miss an event. Use the durable change-feed path when that gap is unacceptable.
Do not enable both paths for the same models: their event IDs represent different
publication streams. Neither path promises atomic network effects with source
writes. Hooks propagate enqueue failures; re-saving a source object does not
reconstruct a missing historical create/update event.

For custom events, authorize the data projection on the server:

```ts
await webhooks.dispatch({
  id: durableDomainEventId, event: 'custom.paid', model: '@example/app:Invoice',
  occurredAt: new Date().toISOString(), data: { id: invoiceId },
});
```

Empty event/model filters mean all events/models. Unknown nonempty custom names
are supported; malformed envelopes and bodies over 256 KiB are rejected.

## Delivery and recovery

A unique `(tenant, subscription, event ID)` outbox row and its jobs enqueue commit
in one database transaction. Repeated dispatch is a no-op for that identity.
Jobs contain only runtime, opaque tenant/delivery IDs, and a replay generation. Five attempts use jobs'
exponential retry (1 second initial delay, multiplier 2, 5 minute cap). A delivery
lease prevents overlapping HTTP attempts; an expired lease permits recovery
after worker death. Terminal writes require the current lease token. Disabled
subscriptions cancel unsent deliveries. Secrets are read at delivery time, so
rotation applies to subsequent attempts.

Call `store.reconcile()` from a tenant-scoped operator sweep to turn exhausted
or cancelled jobs into replayable failed deliveries. Admin refresh also runs
reconciliation. `admin.replay(id)` atomically creates a new job only for a failed
delivery; repeated replay is a no-op. Delivered events are never replayed by this
API. Receivers **must deduplicate `x-smrt-delivery`**: if HTTP succeeds and the
process dies before the outcome commits, recovery can send the same request
again. The package does not claim exactly-once HTTP effects.

## Security contract

Only HTTPS port 443 is allowed, without credentials or fragments. Every resolved
DNS address must be public unicast. The socket lookup is pinned to a validated
answer while TLS still verifies the original hostname. Redirects and connection
pooling are disabled. DNS and request deadlines are 5 and 10 seconds. Special,
private, mapped, transition and documentation IP ranges are conservatively
rejected. Response bodies are never buffered or logged. A transport override is
a **trusted server-only integration seam** and must preserve those requirements.

`x-smrt-signature` is `sha256=<hex HMAC-SHA256(secret, timestamp + '.' + body)>`,
where timestamp is the exact `x-smrt-timestamp` header and body is the exact
persisted UTF-8 request body. Verify in constant time, bound timestamp age, and
deduplicate the delivery ID. Keys require at least 32 bytes of entropy-bearing
secret material (generate them cryptographically; length alone is not entropy).

Secrets and payloads are durable sensitive data: use protected database access,
backups and encryption at rest. Never serialize model instances with `toJSON`
for clients; use the admin service or `toPublicJSON`. The admin view omits secrets,
payloads and lease tokens, and transport errors are fixed safe strings.

## Admin UI and recipe

`WebhookAdmin` from `/svelte` uses smrt-ui Button, Card, Input and Alert primitives.
Supply `subscriptions`, `deliveries`, and async `onCreate`, `onToggle`, `onReplay`
callbacks backed by `WebhookAdminService`. Refresh the view after mutations.
The host owns login, administrator permissions, and CSRF protection. The component
has busy/error states and never receives persisted signing secrets.

The `integrations.webhooks` recipe's server runtime and settings surface await
#3708's shared recipe contract; the coordinator will wire those fields after that
prerequisite lands. The server module and component are usable independently.

## Validation

`pnpm test` exercises persistence, rollback, tenancy, retries, lease fencing,
lifecycle events, redaction, HMAC and DNS pinning. `pnpm check` and
`pnpm typecheck` check public TypeScript/Svelte contracts. `pnpm test:e2e` runs the
maintained Chromium admin interaction harness. Build with
`pnpm exec turbo build --filter=@happyvertical/smrt-webhooks...` from the root.
