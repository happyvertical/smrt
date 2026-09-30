# Remote MCP authorization

See the [MCP Apps integration standard](mcp-apps-integration.md) for portable embedded UI, optional OpenAI extensions, ownership and staged release gates.

This is the deployment contract for Anytown, Ergot, and other applications that
put a SMRT MCP HTTP surface on the public internet. SMRT currently supplies the
application-scoped `/api/mcp` stateless Streamable HTTP endpoint and a local
stdio bridge. The REST-shaped `/api/mcp/tools` and `/api/mcp/call` adapters are
deprecated compatibility routes for one release. SMRT does **not** supply an
OAuth authorization server. Terminate OAuth at the application gateway and
populate the authenticated SvelteKit principal only after token validation.

## Authorization-server contract

Use one stable HTTPS issuer identifier per authorization server. The gateway
must validate token signature, `iss`, audience/resource, expiry, and scopes
before a request reaches the MCP route. Never accept a token minted for another
issuer or resource.

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

## Application wiring

For the application MCP route:

1. Protect `/api/mcp` at the gateway. During the one-release compatibility
   window, apply the same policy to `/api/mcp/tools` and `/api/mcp/call`.
2. Validate the bearer token at the gateway and populate `event.locals.user`,
   `tenantId`, and permissions from the validated principal on every request.
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

## Server-only protected-resource adapter

`@happyvertical/smrt-app-mcp/auth` supplies `createMcpResourceAuth`. It verifies
JWT access tokens using the configured issuer's JWKS with an explicit RS256 or
ES256 allow-list, exact issuer and resource audience, required subject and expiry,
`nbf`, and required scopes. Its default token type is `at+jwt` (RFC 9068). Select
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
return 401 `invalid_token`; insufficient scopes return 403 `insufficient_scope`.
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
