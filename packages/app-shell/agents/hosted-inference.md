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
  rejects `init`, so a cloud process does not start without the gate. Before
  building anything it calls core's `requireInferenceGate(true)`: from then on
  a hosted call that finds no gate (never built, or cleared) is blocked with
  policy `gate-error` and a zero-usage `blocked` row, never run unchecked
  (core's default stays fail-open for other hosts; the flag is per realm). The
  `smrt db:migrate` for the deployment must therefore include the features and
  subscriptions tables (both are in `smrt.config.ts` `consumer.packages`).
- **Tenant context.** Plan and usage rows are tenant-scoped. The gate wraps
  `spend.evaluate` in `withTenant({ tenantId })` unless that tenant is already
  ambient, so a background call that names only a tenant (no user, no session)
  is evaluated and metered for that tenant; the per-user cap applies only when a
  user is present.
- **Whose calls are metered to whom (engine, MCP, jobs).** One rule everywhere:
  the gate and the usage recorder read the acting user from the ambient
  principal (tenancy context, then users session), and only for the tenant the
  call bills. Shell-side MCP tool dispatch (`dispatchTool`), every import-workflow step
  (`runAs` on the stored owner row) and the assistant run inside `runAs`, so
  their calls are metered to the user and held to the per-user cap; a call that
  names a tenant and has no principal (a scheduled job) is metered to the
  tenant, no per-user cap; a principal of another tenant than the one billed
  is never tagged on the row (the usage user resolver gets the billed tenant,
  the same rule the gate applies). The app engine makes no hosted call: its
  worker thread has no inference binding and no gate (both live on the main
  thread), so no hosted target can bind there; if one ever must, the worker
  needs its own gate and `requireInferenceGate`, and `AppRuntime.tenantScope`
  (which enters `{ tenantId }` only) must carry the op principal's user.
  Tests: `hosted-inference-attribution.test.ts`.
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
  (`SMRT_INFERENCE_HOSTED_*`; none = inert; an incomplete one, gateway variables without `SMRT_INFERENCE_HOSTED_PROVIDER`, or a missing `SMRT_SECRET_MASTER_KEY` reject `init`).
  It registers smrt-inference's entitlement-change listener with
  smrt-subscriptions (`registerEntitlementChangeListener`, one registration however
  often it is installed). The billing writer (the host's webhook, wrapped in
  `trackEntitlementChange`, in the tenant it changes) then reconciles the tenant:
  a plan that gains or changes `inference.hosted` provisions a gateway key for each
  active member of the tenant (budget from the grant's `metadata.budget`; a grant
  with none fails the reconcile, reported in the outcome's `failures`), one that
  loses it revokes them. The provisioner's own re-check uses the shell's stores
  (`isHostedInferenceEntitled`), so a stale event after a downgrade does not
  mint a key. The keys are secrets, so `SMRT_SECRET_MASTER_KEY` is checked at `init`. The shell
  has no billing writer: the code that writes plan changes and calls
  `trackEntitlementChange` lives outside this repository, so the listener is an
  exported, tested entry point that stays idle until a host calls it in this process.
- **Not covered.** PostgreSQL (the spend reader's JSON tag matching and
  required-tenancy reads, and the provisioner's per-tenant advisory lock, which
  needs a pool of at least three connections, run on SQLite here); a scheduled
  repair reconcile and provisioning for a member who joins while the tenant is
  already entitled (the host calls `provision()`; no tenant listing or member
  flow in the shell); a hosted call from inside the app worker (see above);
  a removed member's active key is budget-synced but not revoked while the
  tenant stays entitled;
  `app.methods` is wired ([method code](method-code.md)); `plugins.remote`, `sync.devices`, `backup.vault` and `cloud.hosted` have no
  shell surface to gate. `cloud.hosted` is deliberately not a gate on the whole
  cloud shell (v1 decision); the gate is code-local, so that stays possible.
