# Hosted inference (#4759, #4760)

## Provisioning (`src/hosted.ts`, #4759)

`provisionHostedInference({ db, tenantId, userId, budget })`,
`revokeHostedInference({ db, tenantId, userId })`, or one
`createHostedInferenceProvisioner({ db, secrets?, gateway?, admin?, actor? })`
(`provision`, `revoke`, `syncBudget`, `status`, `listActive`, `listKnown`,
`revokeTenant`, `syncTenantBudget`, `reconcileTenant`,
`acknowledgeGatewayRevocation` to drop an owed deletion an operator did by
hand).

- **Gateway.** Admin calls go through `ai.admin` (`AIAdminInterface`) of the
  `bifrost` / `litellm` provider of `@happyvertical/ai` >= 0.111.7
  (happyvertical/sdk#1494); never reimplement gateway administration here.
  `HostedGatewayAdmin` is `HOSTED_GATEWAY_ADMIN_METHODS` (`createProject`,
  `createVirtualKey`, `updateVirtualKey`, `deleteVirtualKey`,
  `listProjects`); a provider missing one is `HOSTED_GATEWAY_UNSUPPORTED`.
  SMRT persists only `AIVirtualKey.id`, the non-secret handle (Bifrost id,
  LiteLLM `token_id`; an id equal to the key is dropped). Budget sync sends
  `updateVirtualKey(id, { budget })` only (Bifrost refuses `models` /
  `metadata`, LiteLLM `providerConfigs`: `ADMIN_UNSUPPORTED_FIELD`);
  `unsupported` now means the grant has no key id. Revoke ends local use
  before touching the gateway (config restored, state retired with the key
  owed, then `deleteVirtualKey`; `false` is `missing`, an already revoked
  key, nothing owed). A deletion the gateway did not perform (`failed`, a
  key a failed provision left, `unsupported`: no admin configured or no key
  id; entries from before 0.111.7 also read `unsupported`) goes to the
  state's `pendingGatewayRevocations` (id + alias, never the key), is
  audited with `manualGatewayRevocation`, and is retried by `revoke()` /
  `reconcileTenant()`; each retry that settles one writes
  `inference.hosted.revoke-retry` with `settled: [{ keyId, keyAlias,
  gateway }]`, closing those records. Entries without an id stay for an
  operator (`acknowledgeGatewayRevocation`).
- **Config, read once from the environment** (`getHostedGatewayConfig()`;
  unset provider = hosted off): `SMRT_INFERENCE_HOSTED_PROVIDER`
  (`bifrost|litellm`), `_BASE_URL` (the OpenAI-compatible endpoint keys are
  used against), `_ADMIN_URL`, `_ADMIN_KEY` (LiteLLM master key, required for
  litellm; or a Bifrost admin key), `_ADMIN_USER` / `_ADMIN_PASSWORD`
  (Bifrost Basic auth), `_MODEL`, `_<TIER>_MODEL`, `_MODELS` (comma list the
  key may use; default the binding's models), `_KEY_DURATION`,
  `_ADMIN_TIMEOUT_MS` (deadline per admin call, default 30 s, also passed as
  the SDK `timeout`; a call past it is a failure, so a stalled gateway never
  holds the lifecycle lock). A create that fails ambiguously (timeout,
  transport reset, 5xx, unclassified; anything but a credential, quota,
  missing-model or refusal answer per `classifyInferenceFailure`) records
  its alias as owed, since the gateway may have minted the key.
  Errors name missing fields, never values.
- **Storage** (smrt-secrets, `context = tenantId`): the key lives only in
  the user's `inference.provider-config:user:<id>` (`source: 'hosted'`,
  `mode: 'hosted'`, `gatewayKeyAlias`, a binding per configured tier);
  `inference.hosted:user:<id>` (category `inference.hosted`) holds status,
  generation, key id and alias, budget and the user's prior config;
  `inference.hosted:project` the tenant's gateway project (created once
  through `runOnce()`, name `smrt tenant <tenantId>`, LiteLLM id
  `smrt-<tenantId>-<nonce>`). Without a stored record, `listProjects({
  tenantId })` runs first and adopts the lowest-id project with that name
  (and id prefix on LiteLLM), audited `adopted: true`, so a crash between
  create and persist never makes a second project; a failed lookup fails
  the provision rather than create blind. Every write passes
  `auditDetails.operation` (`inference.hosted.provision|revoke|budget|project`)
  to `SecretAuditLog`.
- **Idempotency and ordering.** An active grant whose binding is still the
  stored one is returned (`created: false`), its budget synced when it
  differs. The create path runs under `runOnce()` keyed by `(tenantId,
  userId, generation)`; revoke advances the generation. Aliases
  (`smrt-<tenant>-<user>-g<n>-<nonce>`) and LiteLLM project ids
  (`smrt-<tenant>-<nonce>`) are unique per attempt, so a failed attempt's
  leftovers never block the retry. Lifecycle operations run one at a time
  per process (a process-wide chain: rare operations, and it bounds the
  pooled connections held) and, on PostgreSQL, under a per-tenant
  `pg_advisory_xact_lock` held in a transaction for the whole operation
  (its writes use other pooled connections: at most three per process), so
  a tenant-wide revoke or reconcile never misses an in-flight provision.
  The optional `entitled(tenantId)` check runs inside that lock before a
  key is minted (`HOSTED_NOT_ENTITLED`) and before an entitled reconcile
  acts (a stale snapshot then revokes), so a stale gain or late retry after
  a downgrade does not activate. Hosts running the listener or reconciler
  across processes should set it. A failed binding write deletes or records the new
  key and restores the previous state after the claim rolls back (no delete
  inside the claim transaction: single-connection adapters would wait on
  it). A user who replaced the hosted binding keeps their config: an
  explicit `provision()` retires the stale key and mints anew; a reconcile
  only retires it and marks the state `optedOut`, which later reconciles
  respect until an explicit `provision()`. Writes through the #4756
  resolver (the settings panel) do not take this lock.
- **Revoke** restores the prior config when it holds a binding or a mode,
  else writes `{ mode: 'off' }`; a config the user replaced is kept.
- **Budget** is integer micro-dollars (`{ limitMicros, window? }`, `day |
  week | month | year`, default month), converted to the gateway's USD
  `maxLimit` and `1d|7d|30d|365d` only at the admin call. #4760's spend gate
  is the authoritative pre-call check; the gateway budget is defense in depth.
  An unchanged budget is never re-sent (a gateway update may restart the
  spend window); after a failed or timed-out update (`budgetSyncUncertainAt`,
  it may still land) syncs re-apply the stored budget until a confirmed
  update 15 minutes later.
- **Entitlement hook.** `createHostedInferenceEntitlementListener({
  provisioner, users, budgetFor?, defaultBudget? })` structurally matches
  smrt-subscriptions' `EntitlementChangeListener` (register it with
  `registerEntitlementChangeListener()`; the host wraps its webhook write in
  `trackEntitlementChange()`). A change touching `inference.hosted`
  reconciles the tenant to the change's `after` snapshot through
  `createHostedInferenceReconciler()`: entitled provisions `users(tenantId)`
  (membership is the host's; exclude users an operator revoked) unless
  they opted out, and syncs budgets; not entitled revokes every grant; both
  retry owed deletions (also for active grants: they are old keys). The
  plan's budget is the grant's `metadata.budget` (`{ limitMicros, window }`).
  A replayed webhook diffs to "no change", so hosts also call the reconciler
  with `snapshotEntitlements()` on redelivery and on a schedule; that is
  what repairs a reaction lost to a crash. Per-user failures are thrown
  together after all users were tried.
- **Keys.** Never in results, errors (gateway failures carry only the
  operation and error code), audit details, `runOnce()` results or logs.
  Usage rows carry `source: hosted` and `gatewayKeyAlias` (from
  `InferenceTarget.usageTags`). Other processes see a new binding after the
  resolver cache expires; this process is invalidated through
  `invalidateUserInferenceResolvers()`.

## Spend gate and kill switch (`src/gate.ts`, #4760)

`createHostedInferenceGate({ killSwitch, spend, principal?,
requireSubscription?, onWarning? })` is core's `InferenceGate` (seam:
[core inference.md](../../core/agents/inference.md), "Hosted gate");
`registerHostedInferenceGate(gate | options)` installs it and the
principal's user as the `userId` usage tag. Host wiring:

```ts
registerHostedInferenceGate({
  killSwitch: new KillSwitchService({ db }),          // smrt-features
  spend: await HostedAiSpendEvaluator.create({ db }), // smrt-subscriptions
});
```

Both stores are structural: smrt-features and smrt-subscriptions build with
the CLI, which depends on this package, so a dependency on either is a turbo
cycle. Checks, in order, on every `source: hosted` call:

1. **Kill switch** `inference.hosted.enabled` (`HOSTED_INFERENCE_KILL_SWITCH`):
   global DISABLE, then the tenant's DISABLE, blocks (`policy:
   'kill-switch'`, `disabledBy`). Uncached, no model call: **the incident
   lever** (`smrt inference:hosted disable [--tenant <id>]`; programmatic
   `setHostedInferenceEnabled(store, { enabled, tenantId? })`,
   `getHostedInferenceSwitch()`). Stored as smrt-features override rows
   with kill-switch semantics, not as a flag: a tenant ENABLE can never
   lift a global DISABLE, and `inference.hosted` (the plan key) stays a pure
   entitlement. Hosts with an admin UI write the same DISABLE rows through
   `FeatureOverrideService` and their authorizer.
2. **Tenant**: request tenant, else the principal's; none blocks (`no-tenant`).
3. **Entitlement**: no entitled subscription blocks (`subscription`) unless
   `requireSubscription: false`.
4. **Spend**: the plan's tenant and per-user caps (smrt-subscriptions
   AGENTS, "Hosted AI spend caps"): `blocked` blocks with `cap`, `spend`
   (micro-dollars) and `resetsAt`; `warn` returns `warn` and calls
   `onWarning` (errors swallowed). The user is the principal's, only in its
   own tenant, and none for `userId: null` (agents).

Any thrown error propagates and core blocks with `gate-error`. The plan
check does not test the `inference.hosted` feature key: provisioning the
hosted binding (#4759) is where entitlement to hosted is granted.
