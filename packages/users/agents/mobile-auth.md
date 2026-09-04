# Mobile authentication

Read for `src/services/MobileAuthService.ts` and `/sveltekit` mobile handlers.

`createMobileAuthHandlers(options)` (from `/sveltekit`) returns the mountable
server side of the KMP mobile contract: `authStart` (`POST auth/start`,
server-brokered PKCE via `OidcLoginService`), `authComplete`
(`POST auth/complete`, code + echoed `state`/`codeVerifier` → bearer
session), `session.GET`/`session.DELETE` (bootstrap/logout), and
`guard`/`withSession` — the bearer middleware for app-owned mobile routes.
Core logic lives in `MobileAuthService` (framework-agnostic; exported from
the package root).

- **Bearer = session id** (same convention as `TerminalAuthService`); 401
  bodies are `{ error, code }` and drive the mobile client's re-auth flow.
- **Stateless handshake**: the OAuth `state` is an HMAC-signed token
  (secret: `stateSecret` ?? provider `clientSecret`) carrying
  nonce/provider/createdAt — full ID-token nonce verification with no
  server-side pending state. The `codeVerifier` never enters a URL: it is
  client-held per the frozen contract.
- **Wire DTOs** come from `@happyvertical/smrt-mobile-contract`
  (`MobileAuthStartRequest` etc.) — one owning package for the Kotlin,
  Swift, and TypeScript shapes (compile-checked descriptors + parity test).
- **Tenant options** honor `Role.inheritsToDescendants` (#1867): direct
  ACTIVE memberships plus descendants of flagged memberships (nearest
  flagged ancestor labels the option; any direct row pins; inactive direct
  rows exclude). Session binding defaults to the first DIRECT tenant —
  override with `resolveTenantId`.
- **Hooks**: `resolveUser` (invite-gating; default provisions via
  `getOrCreateFromOidc`), `resolveTenantId`, `buildExtras` (bootstrap
  `extras`; model JSON must use `toPublicJSON({ permissions })` — #1822).
  `buildExtras` is the only app-domain bootstrap extension point. Never emit
  app fields such as `dashboard` at the response top level: they are outside
  `MobileSessionBootstrap` and the Kotlin decoder ignores them.
- **Guard** wraps `withSessionPermissionContext`, so
  `assertOperationPermission`, tenancy context, and Postgres RLS all see the
  bearer caller; `OperationPermissionError` maps to 403 with a
  machine-readable `reason`.
- **Uploads**: `resolveMobileUploadDedupKey` + the documented contract in
  `docs/content/architecture/mobile-upload-contract.md` (`clientCaptureId`
  field, `Idempotency-Key` header fallback); domain ingestion stays
  app-side. Framework-model writes ride `sync/apply`, not this path.
- Configure `redirectUris` in production — RFC 8252 scheme rules always
  apply, but the allow list is the defense against redirecting authorization
  responses to attacker-controlled URIs.
