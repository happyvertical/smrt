# Hosted inference in the cloud profile (#5194)

Source: `src/lib/server/hosted-inference.ts`, `assistant/config.ts`,
`hooks.server.ts` (`init`). Tests: `hosted-inference.test.ts` (real
features/subscriptions/gate on SQLite, fake resolver), `hooks.server.test.ts`.

- **Startup.** `init` calls `installHostedInferenceGate({ db })` after
  `runtime.ready()`. Cloud only (local returns before building anything, so the
  desktop never imports smrt-features/smrt-subscriptions at runtime and registers no
  gate or usage user resolver). It builds smrt-features' `KillSwitchService` and
  smrt-subscriptions' `HostedAiSpendEvaluator` over the deployment database
  (`runtime.deployedRuntime().db`, not `getShellDb()`: the gate runs without a
  tenant), reads the global kill switch once, then
  `registerHostedInferenceGate`. Any failure (missing tables, no database)
  rejects `init`, so a cloud process does not start without the gate. The
  `smrt db:migrate` for the deployment must therefore include the features and
  subscriptions tables (both are in `smrt.config.ts` `consumer.packages`).
- **Tenant context.** Plan and usage rows are tenant-scoped. The gate wraps
  `spend.evaluate` in `withTenant({ tenantId })` unless that tenant is already
  ambient, so a background call that names only a tenant (no user, no session)
  is evaluated and metered for that tenant; the per-user cap applies only when a
  user is present.
- **Assistant.** In cloud `resolveAssistantOptions` accepts the owner's own key
  (as before) or a stored `source: 'hosted'` binding that carries its own key and
  whose `baseUrl` is the operator gateway's origin
  (`getHostedGatewayConfig().baseUrl`). A hosted binding additionally requires
  the registered gate and the standard feature `FEATURE_INFERENCE_HOSTED`
  (`assertHostedInferenceEntitled`: plan grant source + overrides); otherwise it
  is refused with core's entitlement `InferenceUnavailableError`. There is no
  silent fallback to another key: a hosted binding that is refused says why.
  The operator's environment key is still never used.
- **Messages.** `unavailableBody` names the policy: kill switch ("paused"), no
  plan ("not included in the current plan"), spend cap ("limit has been
  reached", with the reset date), gate error; the plan and cap messages point
  the owner at their own API key in Settings.
- **Provisioning and the entitlement listener.** `hosted-provisioning.ts`
  (`installHostedProvisioning`, called from `init` right after the gate): cloud
  only, and only when the operator configured a gateway
  (`SMRT_INFERENCE_HOSTED_*`; none = inert, an incomplete one rejects `init`).
  It registers smrt-inference's entitlement-change listener with
  smrt-subscriptions (`registerEntitlementChangeListener`, one registration however
  often it is installed). The billing writer (the host's webhook, wrapped in
  `trackEntitlementChange`, in the tenant it changes) then reconciles the tenant:
  a plan that gains or changes `inference.hosted` provisions a gateway key for each
  active member of the tenant (budget from the grant's `metadata.budget`; a grant
  with none fails the reconcile, reported in the outcome's `failures`), one that
  loses it revokes them. The provisioner's own re-check uses the shell's stores
  (`isHostedInferenceEntitled`), so a stale event after a downgrade does not
  mint a key. Needs `SMRT_SECRET_MASTER_KEY` (the keys are secrets). The shell
  has no billing writer: nothing fires the listener until the host's webhook
  runs in this process.
- **Not covered.** PostgreSQL (the spend reader's JSON tag matching and
  required-tenancy reads, and the provisioner's per-tenant advisory lock, which
  needs a pool of at least three connections, run on SQLite here); a scheduled
  repair reconcile and provisioning for a member who joins while the tenant is
  already entitled (the host calls `provision()`; no tenant listing or member
  flow in the shell); the caller (user) of an engine, MCP or job call, so
  per-user caps and attribution there wait for #5188/#5189/#5375;
  `plugins.remote`, `sync.devices`, `backup.vault` and `cloud.hosted` have no
  shell surface to gate.
