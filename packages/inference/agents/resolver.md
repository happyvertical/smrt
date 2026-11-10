# Per-user and per-tenant bindings (`src/resolver.ts`, #4756)

`createUserInferenceResolver({ db | secrets, fallback?, ttlMs?, principal? })`
is core's `InferenceResolver`. Per tier, highest first: the user's stored
config (its `tiers[tier]`, then its default binding), the tenant's (same
order), `fallback`, the app `inference` block, then the configured client
(`SMRT_AI_*` / process `ai`). Every resolution carries `target.source`
(`byo | local | hosted | app`); core records it as the `source` usage tag.

- **Registration order.** `registerUserInferenceResolver(r)` installs
  `createInferenceResolver(r)`: the #4752 validating resolver stays outermost
  (chain config is validated first), then the user resolver, then its
  `fallback`, then core's config resolution. A later `registerInference()`
  keeps it (the wrapper is marked as this package's own); a bare
  `setInferenceResolver(r)` would drop the validation.
- **Storage.** One smrt-secrets type, `inference.provider-config`
  (`category`), via `SecretService.store()` / `retrieve()` only, with
  `context = tenantId`. Names: `inference.provider-config:user:<userId>` and
  `inference.provider-config:tenant`. The value is
  `{ provider, baseUrl, model, apiKey, preset, params, source?, mode?,
  gatewayKeyAlias?, tiers? }`; hosted (#4759) writes the same type with
  `source: 'hosted'` and `gatewayKeyAlias` (refused on any other source;
  every target of the config carries it as `usageTags`).
  `parseInferenceProviderConfig()` requires every binding to be
  self-contained (`baseUrl` and `apiKey`, `'smrt-local'` for keyless local
  servers, or a preset that supplies the endpoint), so a stored binding never
  borrows the server's environment credentials; it also refuses a `baseUrl`
  with userinfo, query or fragment, `params` beyond the scalar generation
  options in `INFERENCE_PROVIDER_PARAM_KEYS`, a preset without a model,
  unknown fields, and `source: 'app'`. Redaction copies known non-secret
  fields only. A corrupt stored value fails the call with
  `InferenceProviderConfigError` (paths only, never values); a missing,
  disabled or expired secret is simply no layer.
- **Identity.** The ambient principal (tenancy context, then the users
  session context: smrt-preferences' order). With a principal: its tenant
  and user. A request for another tenant (an object of tenant B used by a
  principal of A) reads nothing stored and falls through to app config,
  unless `allowCrossTenant` (then B's tenant layer, no user). No principal
  (jobs): the request's tenant, no user layer, never a guess.
  `request.userId === null` (core `resolveInferenceTarget({ userId: null })`)
  skips the user layer for clients shared beyond one user (agents); a string
  `userId` is ignored.
- **Cache.** Decrypted layers per `(tenantId, userId)` for `ttlMs` (30 s);
  failed loads are evicted. `write(level, config)` / `remove(level)` store
  for the current principal and invalidate; `invalidate()` takes all, one
  tenant (every user), or one user. Who may write the tenant config is the
  host server action's decision (#4754).
- **Mode (#4757).** A stored config may carry `mode` (`byo | local | hosted
  | off`) and may hold only a mode (no binding, no key). The user's mode,
  else the tenant's, applies: `off` answers every tier `{ unavailable:
  'off' }` and `mode()` (untiered calls) `{ mode: 'off', unavailable: 'off' }`;
  `byo` / `local` / `hosted` bind only a stored binding of that `source`
  (user, then tenant), else `unavailable: 'unconfigured'`, never app config.
  No mode: the order above, reporting the binding's source as `mode`.
  `mode()` returns an explicit mode, which core uses to route untiered calls
  through `auto` (so they bind the same way).
  `setMode(level, mode | null)` keeps the binding (deletes a config left
  empty) and invalidates; `write()` replaces the whole config, mode
  included. `resolveBindings()` adds `mode: { mode, layer }`. The #4752
  wrapper forwards `mode()` only when the base has one.
- **Keys.** Never logged or tagged. `resolveBindings()` returns the tier map
  and both stored configs redacted by default (`hasApiKey`, no `apiKey`), the
  shape the settings panel reads; `redact: false` is server-only.
- Raw `getAI()` sites take the binding through core's
  `resolveInferenceTarget()` (see [core inference.md](../../core/agents/inference.md)).
