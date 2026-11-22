# Remote MCP authorization

See the [MCP Apps integration standard](mcp-apps-integration.md) for portable embedded UI, optional OpenAI extensions, ownership and staged release gates.

This is the deployment contract for Anytown, Ergot, and other applications that
put a SMRT MCP HTTP surface on the public internet. SMRT currently supplies the
application-scoped `/api/mcp` stateless Streamable HTTP endpoint and a local
stdio bridge. The REST-shaped `/api/mcp/tools` and `/api/mcp/call` adapters are
deprecated compatibility routes for one release.

`@happyvertical/smrt-app-mcp` validates tokens and trusts the principal your
application supplies; it is not itself an authorization server. SMRT supports
two issuer paths, and a deployment picks one:

- **The application is its own issuer.** `@happyvertical/smrt-users` runs an
  OAuth 2.0 authorization server (built on `@happyvertical/auth/server`): the
  authorization-code flow with S256 PKCE, rotating refresh tokens with replay
  revocation, RFC 8414 discovery, a JWKS endpoint, token revocation, RFC 8707
  `resource` binding (the resource becomes the token `aud`), RFC 9207 `iss` on
  authorization responses, and opt-in RFC 7591 Dynamic Client Registration.
  The host owns the login and consent screens. Login can be any smrt-users
  session method, including delegating to an external OIDC identity provider.
  Wire it with `SmrtOAuthAuthorizationService` and the `createOAuthHandlers`
  export of `@happyvertical/smrt-users/sveltekit`; see the package's
  `agents/oauth-authorization.md`.
- **An external issuer.** Point the application gateway or the server-only JWT
  adapter below at an existing issuer you operate or rent, such as Keycloak or
  Cognito.

In both paths, validate tokens before supplying an authenticated principal and
resolve current application membership and tenant authority on every request.

## Authorization-server contract

Use one stable HTTPS issuer identifier per authorization server. The application gateway or server-only JWT adapter
must validate token signature, `iss`, audience/resource, expiry, and scopes
before protected MCP operations run. Never accept a token minted for another
issuer or resource. This contract applies equally to the `@happyvertical/smrt-users`
issuer and to an external one.

The authorization server metadata must:

- expose the exact issuer as `issuer`;
- set `authorization_response_iss_parameter_supported: true` and include that
  exact value as `iss` in successful and error authorization responses;
- advertise `client_id_metadata_document_supported: true` when supported;
- expose `registration_endpoint` only when RFC 7591 Dynamic Client Registration
  is intentionally retained as a compatibility fallback.

Clients compare response `iss` and discovered `issuer` with exact string
comparison. A missing `iss` from a server that advertised support, or any
mismatch (including a trailing-slash difference), aborts the grant before the
authorization code is exchanged.

## Client registration

This section is the client side (the helper a client calls). To make your own
issuer accept CIMD or DCR, see [Server-side client
registration](#server-side-client-registration).

Prefer a pre-registered client when one exists. Otherwise use a Client ID
Metadata Document; use DCR only when the authorization server does not advertise
metadata-document support. `@happyvertical/smrt-app-cli` exports
`resolveMcpClientRegistration()` to apply that order and
`createMcpClientIdMetadataDocument()` to build the document.

```ts
const registration = resolveMcpClientRegistration(serverMetadata, {
  applicationType: 'native',
  clientId: 'https://client.anytown.example/oauth/mcp.json',
  clientName: 'Anytown MCP Client',
  redirectUris: ['http://127.0.0.1:3210/callback'],
});
```

Host the returned metadata document at the exact HTTPS `clientId` URL. It must
remain byte-for-byte identical in its `client_id` field. The helper's DCR
fallback includes `application_type`, `grant_types`, `response_types`, and
`token_endpoint_auth_method`; post that request only to the discovered
`registration_endpoint`.

### ChatGPT and Claude connectors

Give the host the application's public HTTPS Streamable HTTP endpoint. Serve
protected-resource metadata for that exact endpoint and point it at the
application's issuer: the `@happyvertical/smrt-users` authorization server or
an external one the operator runs. Configure registration in the host's connector settings.
The registration helper above applies to clients that call it. The external
host selects and presents its own client identity.

- **ChatGPT.** Select Client ID Metadata Documents (CIMD) when the issuer
  supports them. Verify the HTTPS document's `client_id` and exact redirect
  URI at the issuer. Use DCR as an explicit compatibility mode if CIMD is
  unavailable for the connection, and retain the registered client for the
  lifetime of that connection. The issuer must accept the token endpoint
  authentication method negotiated with the host.
  [OpenAI client registration guidance](https://developers.openai.com/plugins/build/auth#client-registration)
- **Claude.** When adding a custom web connector, choose Claude's published
  identity if the issuer supports it. Choose automatic registration for a
  supported DCR fallback, or supply a previously registered OAuth client
  when the operator manages that client. Verify the selected identity and exact
  callback URI at the issuer.
  [Claude custom connector setup](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)

For either host, verify authorization-code PKCE with `S256`, bind the code to
the client and exact redirect URI, and bind the token to the intended resource.
Verify that the issuer returns its exact RFC 9207 `iss` value and that the host
refuses a mismatched issuer before exchanging the code. Test the registration
mode the connector actually uses and exercise DCR separately if offered.
[MCP authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
· [RFC 9207](https://www.rfc-editor.org/rfc/rfc9207.html)

## Application wiring

For the application MCP route:

1. Protect `/api/mcp` with the gateway or server-only JWT adapter. During the one-release compatibility
   window, apply the same policy to `/api/mcp/tools` and `/api/mcp/call`.
2. Validate the bearer token at the selected boundary and resolve fresh
   application membership, tenant, and permissions on every request. Gateway
   integrations populate `event.locals.user`; the JWT adapter passes its trusted
   mapped principal to the route as shown below.
   `mountMcpRoute` uses that principal for discovery and calls; header presence
   is not authentication.
3. Keep `publicToolPatterns` empty unless anonymous read access is deliberate.
4. Preserve tenant isolation and the app allow-list for every tool invocation.
5. Do not expose the generated stdio server remotely; stdio obtains credentials
   from its environment and has no per-request OAuth principal.

The app CLI and its stdio MCP bridge use SMRT's first-party terminal device flow,
not the MCP authorization-code flow. The terminal start response emits an
issuer, and stored bearer tokens are keyed by that exact issuer and sent only to
the server saved with the login. `@happyvertical/smrt-agents` ships no MCP client
or OAuth credential store, so RFC 9207 and client registration are not
applicable to that package today.

In the `local` profile there is no authorization server. Instead, the owner
mints a scoped, expiring, revocable bearer token on the machine with
`smrt app token --scopes …`. The runtime stores only its HMAC. The bridge
sends it as `<PREFIX>_TOKEN`. `mountMcpAppRoute({ runtime })` (or the
hand-wired `createHostedMcpResourceAuth({ profile, runtime })`) accepts it
through the same `auth`/`bindPrincipal` path, capped to the owner's live
permissions; the route resolves the profile per request and fails closed when
the runtime cannot supply the profile's adapter. Hosted profiles use the runtime's membership-backed
`resolveMcpPrincipal` unless the application supplies `resolvePrincipal`.

Agent users (a user whose profile is a `bot` profile) map to `kind: 'agent'`;
the default policy accepts that kind only when `principalKinds` lists it. Token
scopes are capped by the agent's live role permissions on every request, a tool
it may not use is absent from `tools/list`, and a call to it is refused exactly
like a call to an unknown tool.

### Write tools

Keep the remote tool catalog read-only until the application supplies and tests
an authorization policy for each exposed write operation. Before a mutation,
require the operation's scope and check the actor's current membership,
permission, active tenant, and access to the target record using the server's
trusted context. Apply the same checks when a task resumes or retries. Derive
the tenant and actor from that context and look up any required approval in the
owning workflow. Host confirmations and tool annotations describe intent.

For example, an `applications:prepare` grant can allow an authorized member to
create a pending application in their tenant. Repeating the request must
preserve the owning workflow's idempotency and audit trail. Employer submission
requires the separate human approval in the product's review flow. See the
[MCP Apps security and deployment invariants](mcp-apps-integration.md#security-and-deployment-invariants).

## Waking agents with signed webhooks

An agent that is not connected can be woken by an outbound webhook, then call
the MCP endpoint with its own grant. `@happyvertical/smrt-webhooks` delivers
tenant-scoped events to public HTTPS port 443 endpoints with an HMAC signature
and a durable retry queue. Each subscription may carry a `signingProfile`
(`WebhookAdminService.create({ url, events, models, secret, signingProfile })`)
so the receiver verifies its own scheme without a proxy:

- `paperclip`: `x-paperclip-signature` and `x-paperclip-timestamp` (Unix
  seconds), `sha256=<hex>` over `timestamp.body`.
- `standard-webhooks`: `webhook-signature`, `webhook-timestamp` and
  `webhook-id`, `v1,<base64>` over `id.timestamp.body`.
- `default`: `x-smrt-signature` and `x-smrt-timestamp` (ISO 8601).

Payloads are identity-only (`{ id }`); the woken agent fetches the data over
MCP, where tenant and permission checks apply. Verify with
`verifyWebhookSignature({ secret, body, timestamp, signature, profile:
resolveWebhookSigningProfile('paperclip') })` (add `deliveryId` for
`standard-webhooks`). Secrets need 32+ bytes of real entropy. Adding the
`signingProfile` column needs the normal migration. See the
`packages/webhooks/README.md` "Signing profiles" section.

## Confirming dangerous tools

`confirmTools: ['*_send', '*_publish', '*_pay', '*_delete']` on
`createMcpAppServer` (or `mountMcpAppRoute`) refuses a matching tool unless
`arguments.confirm === true`. The refusal is an `isError` result with
`structuredContent.error.code === 'confirm_required'`, runs before any assertion
or handler, is audited `denied`, and discovery advertises the boolean `confirm`
argument. A workflow tool's own `requiresConfirm` combines with it. This is a
guard against an agent acting without asking its user: the host or model
supplies the flag, so it does not replace per-operation scopes (`toolScopes`),
`effects: ['read']` or a human sign-off in `@happyvertical/smrt-approvals` for
actions that must not proceed on the agent's word alone. Patterns that match no
tool log a one-time warning.

### Scopes and narrowing

A client may request more scopes than the signed-in user holds. Consent grants
the requested scopes whose mapped permissions the user holds (requested ∩ held)
and refuses with `access_denied` only when none remain. Nobody, human or agent,
receives a scope whose permissions their role lacks. The consent data
(`createOAuthHandlers().authorize`) lists the narrowed `scopes`, with the
original in `requestedScopes` when they differ; the stored grant, the access
and refresh tokens and the token response `scope` carry only the narrowed set.
A refresh never widens: asking for more than the grant is `invalid_scope`, and a
role that lost a mapped permission is refused. To keep all-or-nothing consent for
an app that needs it, pass `refuseUnheldScopes: true` to
`SmrtOAuthAuthorizationService.create`.

The resource then requires a token to carry at least one of its advertised
scopes (none: 403 `insufficient_scope` with `scope="..."` naming them);
`scopes_supported` is unchanged. Which tools a token may call is decided per
tool: `toolScopes` and a workflow tool's `requiredScopes` list the scopes that
tool needs, `tools/list` hides tools the token does not cover, and a call
outside them is refused exactly like an unknown tool. Fail closed: a tool with
no `toolScopes`/`requiredScopes` mapping requires every scope the resource
advertises, so a narrowed token neither sees nor calls it. Apps that want
narrowed tokens must map every tool in `toolScopes`. `requiredScopes` on
`mountMcpAppRoute` is the baseline every tool needs; keep it `[]` and map each
tool to its own scope. The live role cap (runtime binder) still applies on every
call.

Migration: an app that kept `requiredScopes` equal to every advertised scope now
accepts narrowed tokens at authentication, and every tool then answers 404
instead of 403 `insufficient_scope`. Use `requiredScopes: []` with a complete
`toolScopes` map. A private resource no tool references also needs every
advertised scope, and an authorization request with no `scope` parameter is now
refused with `access_denied` instead of storing an empty grant.

Consent only ever removes scopes: one with no `scopePermissions` entry is dropped
from the grant, never added. A host that wants a request containing an unheld or
unmapped scope refused outright sets `refuseUnheldScopes: true`.

## Agent-ready app checklist

In order; each step names where it is specified.

1. Declare the `@smrt()` models and publish only chosen ones:
   `mountMcpAppRoute({ runtime, models, requiredScopes, effects: ['read'] })`.
   Keep the catalog read-only until each write has a policy.
2. Pick the issuer: app as issuer ("The app as its own issuer") or an external one
   (`createMcpResourceAuth`). Local installs use `smrt app token`.
3. App as issuer: apply migrations, create the server with
   `createCimdAuthorizationServer`, mount `createOAuthHandlers().protocol`, and
   build the consent and grants pages. Set `scopePermissions` for every scope.
4. Pass `mcp: { authorizationServer: { server, authorization, resource, scopes } }`
   to `createSmrtSvelteKitRuntime`; mount the MCP route and
   `mountMcpProtectedResourceMetadataRoute({ runtime })` at the exact RFC 9728
   path.
5. Choose registration: pre-register your own clients, enable CIMD with a real
   `allowClientOrigin` policy for ChatGPT and Claude, and enable
   `dynamicClientRegistration` only if a host needs it.
6. Restrict what agents see and do: `toolScopes`, `toolPolicy`, `effects`,
   `confirmTools`, and `@happyvertical/smrt-approvals` for human sign-off.
7. Audit calls: `auditSink: createSmrtMcpAuditStore({ smrtOptions })` and
   `auditTenantId`.
8. Wake agents without polling: a webhook subscription with the
   `paperclip` or `standard-webhooks` signing profile.
9. Verify against the Deployment verification list below: wrong issuer, wrong
   audience, no token, then revoke the grant and confirm the next call is
   refused.
10. Connecting an orchestrator such as Paperclip: follow "Deploying with
    Paperclip and similar orchestrators" (quarantine on, one install per agent).

## Deployment verification

Before promoting Anytown or Ergot:

- fetch authorization-server metadata and assert the issuer and both advertised
  capabilities match deployment policy;
- have the authorization server fetch the HTTPS Client ID Metadata Document and
  reject a request whose redirect URI is not listed;
- exercise the DCR compatibility path, when enabled, and capture the received
  request showing `application_type`;
- confirm a callback with the expected `iss` succeeds, while missing and
  mismatched `iss` values fail before the token endpoint is called;
- log in the app CLI, switch its server URL, and confirm the prior bearer token
  is not sent;
- call a protected MCP tool with a valid token, a token from another issuer, a
  token for another audience, and no token; only the first request may dispatch.

Keep issuer metadata, client documents, and gateway policy in deployment source
control. Never place client secrets or bearer tokens in the repository.

For live host qualification, repeat the following on ChatGPT and Claude with a
test tenant. Record the date, host and version if visible, server revision,
selected registration mode, and sanitized outcomes in
[the MCP Apps integration epic](https://github.com/happyvertical/smrt/issues/3202).

- Connect, sign in, and call a permitted read tool. Record the issuer-observed
  client identity, callback, `S256` challenge method, and resource. Verify the
  issuer rejects an invalid verifier and unregistered redirect. Record any
  failure probes performed with a separate test client as fixture evidence.
- Exercise issuer mismatch, wrong resource, missing scope, and revoked
  membership. Verify the failed grant or tool denial occurs before dispatch.
- If write tools are enabled, create one pending record with an allowed actor.
  Retry it and verify the same outcome. Attempt the same operation as a read-only
  actor and against another tenant's record. Verify both requests leave state
  unchanged and the pending record requires product approval to advance.

## Deploying with Paperclip and similar orchestrators

Paperclip is a self-hostable agent orchestrator. It connects to a generic
remote MCP server over OAuth and drives its agents against the tools it lists;
no Paperclip-specific connector exists or is needed. The notes below describe
what Paperclip v2026.1106.0 does and how to configure an app so that it is
safe to connect.

**Reference app configuration.** Only documented options are used; the
registration, login and consent pieces are the host's own.

```ts
const authorization = await SmrtOAuthAuthorizationService.create({
  db,
  // scope -> permissions the user must hold. A client that asks for more
  // scopes than the user holds gets a token for the subset (see "Scopes").
  scopePermissions: {
    'notes.read': ['notes.read'],
    'notes.write': ['notes.write'],
    'notes.delete': ['notes.delete'],
  },
});
const server = createCimdAuthorizationServer({
  issuer: 'https://app.example/oauth', storage, signingKey,
  identity: authorization.identity, scopes, resources: [resource],
  dynamicClientRegistration: true, // what Paperclip uses
  clientIdMetadataDocuments: {
    allowClientOrigin: (origin) => origin === 'https://paperclip.example',
  },
});
const runtime = createSmrtSvelteKitRuntime({
  mcp: { authorizationServer: { server, authorization, resource, scopes } },
});
export const POST = mountMcpAppRoute({
  runtime, models: [Note], requiredScopes: [],
  principalKinds: ['human', 'agent'], // agents are bot-profile users
  toolScopes: { note_list: ['notes.read'], note_get: ['notes.read'],
    note_create: ['notes.write'], note_delete: ['notes.delete'] },
  confirmTools: ['note_delete'],
  approvals: createApprovalMcpGate({ service: approvalService }),
  auditSink: createSmrtMcpAuditStore({ smrtOptions }),
  auditTenantId: ({ principal }) => principal?.tenantId,
});
// Wake-up: webhooks.create({ url, events, models, secret,
//   signingProfile: { preset: 'paperclip' } }) against the trigger URL.
```

**Guidance.**

- **Turn quarantine on.** A connection made from a pasted URL is created with
  `quarantineNewEntries: false`, so every discovered tool is active and
  callable at once, including a tool added later. Set
  `quarantineNewEntries: true` in the connection's `config` and
  `transportConfig` (PATCH `/api/tool-connections/:id`). A tool discovered
  afterwards then arrives `quarantined` (`pending_review`) and calls to it
  are refused until an operator enables it. Do this before enabling write or
  destructive tools.
- **One connection per agent.** A Paperclip connection holds one credential.
  Make one connection per agent, sign in as that agent's smrt user (a `bot`
  profile with its own limited role) when authorizing, and install the
  connection on that agent only (PUT `/api/tool-connections/:id/installs` with
  an `agent` target). Each agent then has its own principal, role cap, audit
  trail and revocable grant. In the acceptance stack every new Paperclip agent
  also held an unscoped explicit `tools:use` grant, which allows any
  connection regardless of installs; remove or scope it for each agent, or
  installs do not isolate anything.
- **Annotations Paperclip reads.** `readOnlyHint` (read), `destructiveHint`
  (destructive) and `readOnlyHint === false` (write), plus tool-name verbs. It
  ignores `_meta`, `outputSchema` and `openai/*` keys. The generated
  `*_list` and `*_get` tools list as read, `*_create` as write and `*_delete`
  as destructive. Set an honest annotation on every workflow tool.
- **No `list_changed`.** Paperclip lists tools when it connects and when an
  operator refreshes the catalog; it never reacts to `tools/list_changed`.
  After a role or scope change, refresh the catalog or reconnect. Until then a
  stale entry is refused by the live check exactly like an unknown tool.
- **Refresh tokens are used.** Paperclip sends a `refresh_token` grant with
  the `resource` parameter when the access token expires, whether or not the
  server advertises refresh. Keep `refresh_token` in `grant_types_supported`
  (the smrt-users server does) and keep revocation family-wide: after a
  grant is revoked the refresh is refused and Paperclip drops the connection
  to a draft that needs reauthorization.
- **Path-insertion discovery routes.** Paperclip probes the endpoint, reads
  RFC 9728 metadata at `/.well-known/oauth-protected-resource/api/mcp`, then
  RFC 8414 metadata at `/.well-known/oauth-authorization-server/oauth` (path
  insertion for an issuer with a path). Mount both, and the OIDC form for
  clients that try it. No suffix-form request was needed.
- **HTTPS everywhere.** Paperclip registers as a `web` application and the
  issuer refuses an `http://` redirect URI, so run Paperclip with an HTTPS
  public URL. The issuer and resource must be HTTPS and use a certificate the
  Paperclip server trusts.
- **Registration.** DCR works as is. CIMD needs a client document at a public
  HTTPS URL with a default port, which the issuer fetches with its SSRF guard;
  it cannot be exercised from a private lab network.
- **Scopes.** Paperclip requests every scope in `scopes_supported` and cannot
  ask for fewer. Consent grants the requested scopes the user holds, so an
  agent whose role holds only `notes.read` receives a token whose `scope` is
  `notes.read` (RFC 6749 section 3.3) and can call only the tools that scope
  covers. A limited agent therefore needs two things from the app: mount with
  `legacy: 'stateless'` (next bullet) and a complete `toolScopes` map with
  `requiredScopes: []`; no `scopePermissions` workaround is needed. See "Scopes
  and narrowing" below.
- **Protocol era.** Paperclip speaks the 2025 JSON-RPC handshake (unversioned
  `tools/list`, then `initialize` with `2025-06-18`). The endpoint is
  modern-only by default and answers it `-32022`, so a stock app does not
  connect. Mount with `legacy: 'stateless'` (`mountMcpAppRoute` or
  `mountMcpRoute`; mount-time only) to opt in (#5109). Legacy requests are
  served by the same per-request server factory and bound principal as modern
  ones, so the OAuth challenge, grant liveness, live role cap, `toolScopes`,
  404 for unknown or forbidden tools, and approvals apply unchanged; legacy
  clients get stateless semantics (no sessions, no `list_changed`).
- **Webhook receivers** must currently be public HTTPS on port 443 (#5111).
  The dispatcher's `transport` option is a test-only seam: it skips the
  HTTPS, port 443 and SSRF rules and must not be used in production.

Claims about Paperclip's own behaviour above (`quarantineNewEntries`, the
install endpoints, the default per-agent `tools:use` grant, handshake and
discovery order) were observed in v2026.1106.0 and may change.

### Acceptance results

Run on 2026-11-17 against Paperclip v2026.1106.0 (image
`ghcr.io/paperclipai/paperclip:2026.1106.0`, commit `d69631b`), authenticated
deployment, with a reference app built from the options above on SQLite, the
app as its own issuer behind a private test CA. smrt revision: release branch
`release/5079-agent-ready-apps` at `f38c19ba6d`, with the `legacy: 'stateless'`
option of the SDK `createMcpHandler` switched on locally for every row marked
(a) and the dispatcher `transport` seam used for row 6 (b); nothing else was
patched.

The "Fail without patch (#5109)" rows below describe the default,
modern-only mount. The opt-in `legacy: 'stateless'` is the supported way to
run them, and it is what local patch (a) switched on. The opt-in is covered by
in-process tests (`legacy-protocol.test.ts`: both mounts, handshake, role
filtered list, call, forbidden equals unknown, 401 challenge, revoked grant,
approval hold, modern unchanged, default `-32022`); the live Paperclip run
has not been repeated against the shipped option.

| # | Step | Result | Evidence |
| --- | --- | --- | --- |
| 1 | OAuth connect: discovery, registration, resource, refresh | Fail by default (#5109), passes with `legacy: 'stateless'` (local patch (a) in this run); CIMD not run | Probe 401 with `WWW-Authenticate`, then RFC 9728 and RFC 8414 path-insertion fetches, both 200; DCR `POST /oauth/register` 201 (`application_type: web`, https callback); code exchange with S256 and `resource`; refresh grant with `resource` after expiry returned 200 and a new token. Without (a) the connection fails at the handshake: #5109. CIMD is refused by design for a private host (`invalid_url`). |
| 2 | Per-agent connection and install | Pass | Two connections, each authorized as a different smrt agent user, installed on one Paperclip agent each; the audit store shows two distinct principals of kind `agent`; access for the other agent was `off` once its default `tools:use` grant was removed. |
| 3 | Tool listing and annotations | Fail by default (#5109), passes with `legacy: 'stateless'` (local patch (a) in this run) | Agent with write and delete roles saw 4 tools (`readOnlyHint` on list/get, `destructiveHint` on delete); the read-only agent saw 2. Paperclip classed them read, write and destructive. |
| 4a | Scoped call, then refusal after the role permission is revoked | Pass | `note_create` ran; after removing `notes.write` from the role the next call returned "Unknown MCP tool", audited `denied` (`mcp_tool_access_denied`); `note_list` still ran with the capped scopes. |
| 4b | Refusal after the grant is revoked | Pass | The next call returned 401 `invalid_token`; the refresh was refused; Paperclip showed "OAuth authorization has expired. Reconnect"; the other agent's connection was unaffected. |
| 5 | Gated destructive call held, person approves, runs once | Pass | `note_delete` answered `approval_pending`; retry before approval stayed pending; a human with `approvals.approve-mcp-tool` approved; the identical retry deleted the note once; a further identical call opened a new pending request. Audit: `approval_requested`, `approval_pending`, `approval_consumed`. |
| 6 | Routine trigger fired by a smrt webhook | Fail for a private receiver (#5111); passes via test seam (b) | Trigger in `hmac_sha256` mode; subscription with the `paperclip` preset; delivery got 202 and created a routine run with `source: webhook` and an identity-only payload; a request signed with the default `x-smrt-*` headers or a wrong digest got 401. (b) The destination was not public port 443, so delivery used the dispatcher's trusted `transport` seam: #5111. |
| 7 | Quarantine | Pass | With `quarantineNewEntries: false` a newly permitted tool was active and callable after a catalog refresh; with `true` it arrived `quarantined` and calls returned `tool_not_found`. |

Re-run this table when Paperclip or the MCP protocol revision changes.

## Server-only protected-resource adapter

`@happyvertical/smrt-app-mcp/auth` supplies `createMcpResourceAuth`. It verifies
JWT access tokens using the configured issuer's JWKS with an explicit RS256 or
ES256 allow-list, exact issuer and resource audience, required subject and expiry,
required scopes, and `nbf` when present. `nbf` is optional. Its default token type is `at+jwt` (RFC 9068). Select
`tokenType: 'JWT'` only when the configured provider uses that type for access
tokens; ensure that provider cannot issue an ID token with this resource's
audience. Opaque access tokens and introspection are not implemented by this
adapter; use an existing validating application gateway for those providers.

```ts
import { createMcpResourceAuth } from '@happyvertical/smrt-app-mcp/auth';
import { mountMcpRoute } from '@happyvertical/smrt-app-mcp/sveltekit';

const auth = createMcpResourceAuth({
  profile: 'self-hosted',
  resource: 'https://app.example/api/mcp',
  issuer: 'https://identity.example/',
  jwksUri: 'https://identity.example/keys',
  algorithms: ['RS256'],
  scopes: ['mcp:read'],
  async resolvePrincipal({ issuer, subject }) {
    // Application-owned lookup: exact provider identity, enabled account,
    // current active tenant and membership. This is a required callback.
    const member = await accounts.resolveActiveMembership(issuer, subject);
    return member ? { id: member.userId, tenantId: member.tenantId,
      roles: member.roles } : null;
  },
});

const route = mountMcpRoute(mcpServer);
export async function POST(event) {
  const result = await auth.authenticate(event.request);
  if (!result.ok) return result.response;
  return route({ ...event, locals: { ...event.locals, user: result.principal } });
}
// In a separate GET route at auth.metadataUrl:
// https://app.example/.well-known/oauth-protected-resource/api/mcp
export const GET = () => auth.metadataResponse();
```

The route example's `accounts` and `mcpServer` are application dependencies, not
new framework services. Mount metadata at the exact `metadataUrl`, including
the resource path inserted after `/.well-known/oauth-protected-resource` per
RFC 9728. Missing credentials return a 401 discovery challenge; invalid tokens
return 401 `invalid_token`; a token that carries none of the resource's scopes
returns 403 `insufficient_scope` with a `scope` challenge listing them.
Responses never include the bearer credential, claims, or upstream errors.
Protect every protocol request with the same check, including discovery,
resource reads, task continuation and reconnects. Keep the app's operation
policy and object ownership checks: OAuth scopes alone do not establish access
to a particular record.

The resolver receives only verified identity claims. It must use application
state to select a tenant and validate membership on every call. Token tenant
claims, request tool arguments and iframe state must never choose the active
tenant automatically. Missing actor IDs or required tenant IDs fail closed.
`requireTenant: false` is for a deliberately single-tenant application; the
adapter never copies an `allowCrossTenant` override. No users-package adapter
or dependency is introduced: browser OIDC and terminal sessions remain separate
contracts, and deployments supply their existing account/membership service.

### Revocation and reconnect

The adapter caches signing keys using jose's remote-JWKS cache, but never caches
authentication or the mapped principal. Account disablement, application
session revocation and removed membership take effect on the next request **if
the resolver checks that state**. A freshly issued token does not bypass a
resolver denial. JWT signature validation alone does not detect authorization
server token revocation before expiry. Configure short-lived access tokens or
an application/provider revocation check in the resolver when immediate
revocation is required. A JWKS cache is not a revocation list; cached keys may
remain usable during an issuer outage. A required key fetch that fails denies
the request. Provider availability, timeouts and any revocation lookup inside
the callback are the application's responsibility.

### The app as its own issuer

An application that already runs the `smrt-users` OAuth server can be its own
MCP issuer with one runtime option, instead of wiring resource, issuer, JWKS and
metadata by hand. This is the full path, in the order to build it.

**1. Create the issuer.** Apply the normal migrations (the six `users_oauth_*`
models), then build the SDK server from `@happyvertical/auth/server` and the
`smrt-users` consent service and storage. Use `createCimdAuthorizationServer`
(exported from `@happyvertical/smrt-users`) instead of
`createAuthorizationServer` when you also want CIMD; without its
`clientIdMetadataDocuments` option it returns the plain SDK server.

```ts
import { createCimdAuthorizationServer, SmrtOAuthAuthorizationService,
  SmrtOAuthAuthorizationStorage } from '@happyvertical/smrt-users';

const authorization = await SmrtOAuthAuthorizationService.create({
  db,
  // scope -> permissions the user must hold; unknown scopes fail closed
  scopePermissions: { 'items.read': ['items.read'] },
  // Default: grant requested ∩ held. `refuseUnheldScopes: true` instead
  // refuses a request for any scope the user cannot hold.
});
const storage = await SmrtOAuthAuthorizationStorage.create({ db });
const server = createCimdAuthorizationServer({
  issuer: 'https://app.example/oauth',
  signingKey, // OAuthSigningKey: key pair, publicJwk, algorithm RS256|ES256, keyId
  storage,
  identity: authorization.identity,
  scopes: ['items.read'],
  resources: ['https://app.example/api/mcp'],
  // Client registration choices, both opt-in; see "Client registration".
  dynamicClientRegistration: true,
  clientIdMetadataDocuments: { allowClientOrigin: (origin) => allowed(origin) },
});
```

**2. Mount the protocol and consent routes.** `createOAuthHandlers` from
`@happyvertical/smrt-users/sveltekit` returns `authorize`, `consent`, `grants`
and `protocol`. Mount `protocol` at the issuer path (it serves
`/.well-known/oauth-authorization-server`, `/jwks`, `/token`, `/revoke` and,
when enabled, `/register`). The host renders the consent screen at
`authorization_endpoint` (`<issuer>/authorize`) and supplies `getSessionId`
from its existing cookie. Login can be any smrt-users session method,
including an external OIDC provider.

Nothing installs these routes for you: `protocol` only delegates to
`server.handle(request)`, and the runtime option does not mount anything. For
an issuer with a path such as `https://app.example/oauth`, clients that follow
RFC 8414 path insertion request
`https://app.example/.well-known/oauth-authorization-server/oauth`, which is
outside `/oauth/*`. `server.handle` answers that path (and
`/.well-known/openid-configuration/oauth`), so add a host route that forwards it
to the same handler:

```ts
// src/routes/oauth/[...path]/+server.ts  (token, jwks, revoke, register)
// src/routes/.well-known/oauth-authorization-server/oauth/+server.ts
// src/routes/.well-known/openid-configuration/oauth/+server.ts
const handlers = createOAuthHandlers({ server, authorization, getSessionId });
export const GET = (event) => handlers.protocol(event);
export const POST = (event) => handlers.protocol(event); // oauth/* only
```

The RFC 9728 protected-resource document is separate and is served by
`mountMcpProtectedResourceMetadataRoute({ runtime })` at
`/.well-known/oauth-protected-resource/api/mcp`; it advertises the issuer in
`authorization_servers`. Verify both well-known URLs return 200 before
connecting a host.

**3. Hand the issuer to the runtime.**

```ts
export const runtime = createSmrtSvelteKitRuntime({
  mcp: {
    authorizationServer: {
      server,
      authorization,
      resource: 'https://app.example/api/mcp', // else SMRT_MCP_RESOURCE
      scopes: ['items.read'],                  // else SMRT_MCP_SCOPES
    },
  },
});
```

`server` is the SDK server instance and `authorization` the
`SmrtOAuthAuthorizationService` that owns consent grants. Then mount the MCP
endpoint with `mountMcpAppRoute({ runtime, models, requiredScopes })` and the
protected-resource metadata with `mountMcpProtectedResourceMetadataRoute({
runtime })` (see the `smrt-app-mcp` README). With
`createHostedMcpResourceAuth({ runtime })` the hosted profiles then:

- verify the token in process with the issuer's own key (no JWKS fetch, no
  `SMRT_MCP_ISSUER` or `SMRT_MCP_JWKS_URI`), including its audience and
  server-side access-token revocation;
- advertise the app's own issuer in protected-resource metadata. The local
  profile never uses the option.

External identity providers stay the login method through host-owned login and
consent. A runtime without the option behaves exactly as described above.

#### Live revocation

The runtime re-checks the grant on **every call**: `smrt_grant_id` is not
revoked and matches the token, its session and tenant are live, the user is
active, and the user holds an active direct membership in the grant's tenant.
Every id comes from the grant row. Any failure or throw is a 401 and fails
closed, so the call after a revoke is refused even though the JWT has not
expired. Users revoke from their account page through the `grants` handler
(`GET` lists, `POST grantId` revokes); the service form is
`authorization.revokeGrant(sessionId, grantId)`. Revoking or replaying a refresh
token revokes its whole family and consent.

#### Default principal mapping

`sub` becomes the principal id and the grant's `tenant_id` the tenant
(`kind: 'human'`, direct tenancy), re-derived from the live grant: claims never
select a tenant. Pass `resolvePrincipal` to `createHostedMcpResourceAuth` to
override the mapping (for example for multi-tenant users); it never overrides
the liveness check. Tokens from any other issuer take the OIDC identity path.

### Server-side client registration

The server can accept two kinds of clients that are not pre-registered, each
opt-in and off by default. Choose by who the connecting host is:

| Choice | Option | Use when |
| --- | --- | --- |
| Pre-registered | `storage.registerClient({ id, redirectUris, allowedScopes, tokenEndpointAuthMethod: 'none', createdAt })` | You operate the client, or a connector lets you supply a client |
| CIMD | `createCimdAuthorizationServer({ clientIdMetadataDocuments: { allowClientOrigin } })` | The host presents an HTTPS `client_id` URL (ChatGPT, Claude) |
| DCR | `dynamicClientRegistration: true` (RFC 7591, public clients only) | A host only supports automatic registration; keep as a fallback |

CIMD details: `allowClientOrigin(origin, clientId)` is required and construction
throws without it (pass `() => true` explicitly to allow any origin); it runs on
every request, so a policy change is immediate. The server fetches the
document itself with SSRF protection (public DNS answers only, pinned
connection, no redirects, 5 s deadline, 16 KiB cap, at most 8 concurrent
fetches), requires the request's `redirect_uri` to equal a listed entry, rejects
any `client_secret*`, and caches by the response headers. Every failure is
"unknown client" to the requester; `onRejected(clientId, reason)` is for
operator logs. Discovery then advertises `client_id_metadata_document_supported:
true`; DCR adds `registration_endpoint`. Full contract:
`packages/users/agents/oauth-authorization.md`.

### Supported deployment profiles

| Profile | Required configuration | Operator responsibility |
| --- | --- | --- |
| `local` | Resource, issuer and JWKS URLs all use literal loopback hosts (`localhost`, `127.0.0.1`, `[::1]`); HTTP or HTTPS | Bind the HTTP listener to loopback, restrict local storage, configure local credentials, prevent reverse-proxy exposure |
| `self-hosted` | HTTPS resource, issuer and JWKS; explicit asymmetric algorithms and scopes | Existing OAuth issuer/gateway, TLS, account mapping, policy and ownership enforcement |
| `cloud` | Same HTTPS contract plus required tenant mapping by default | Verified customer membership, isolation on every operation, provider availability and revocation policy |

The profile validates configured URLs; it cannot bind a listener or prove cloud
isolation. Configure network binding independently. This adapter does not create
an authorization server, register a host client, issue or refresh tokens, or
add a browser login session. Its Node entrypoint has no Svelte or OpenAI runtime
imports. The authorization server remains responsible for authorization-code
PKCE (`S256`), exact resource binding at authorization and token endpoints,
client registration, exact redirect allow-lists, RFC 9207 issuer identification,
and refresh/revocation policy. Advertise only capabilities actually implemented.

Tool results and hosted UI content leave the installation for the connected
client/host; OAuth does not prevent that disclosure. Keep credentials and
provider claims out of those results and publish only data the actor may see.

### CLI expected-issuer pinning

Set `CliConfigContext.expectedCredentialIssuer` from trusted deployment
configuration or validated discovery when the selected server's issuer is known.
The CLI then requires both the saved server URL and exact issuer to match before
sending credentials. Changing issuer trailing slashes, server paths or ports
does not silently reuse a previous credential. Legacy credentials without an
issuer are refused in this mode. Environment credentials additionally require
`${PREFIX}_TOKEN_ISSUER` to match; `${PREFIX}_SERVER_URL` must still match the
target server. Omitting the expected issuer preserves the existing first-party
device-login contract; it does not discover or validate a new issuer implicitly.

### Evidence and external contract

The `auth.test.ts` and `auth-pkce.test.ts` suites exercise real HTTP JWKS and a
synthetic authorization server, including S256 proof rejection, one-use codes,
resource/redirect binding, callback mix-up checks in the fixture client,
predefined/DCR registration, token failures, principal mapping and reconnect.
The CLI's `mcp-oauth.test.ts` independently covers CIMD document selection and
DCR. The synthetic issuer is a test fixture, not a production identity provider
or a claim that a live OpenAI host has been certified. Hosted profiles validate
HTTPS configuration locally; deployment TLS and real provider policy require an
operator's integration run.

Contract sources: [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728.html),
[RFC 6750](https://www.rfc-editor.org/rfc/rfc6750.html), and
[OpenAI authentication guidance](https://developers.openai.com/plugins/build/auth)
(inspected 2026-09-30). The provider must advertise S256 and token endpoint auth
methods. Current OpenAI hosts support CIMD, DCR and predefined clients; configure
and test the mode actually used by the connection.
