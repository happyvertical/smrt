# Remote MCP authorization

This is the deployment contract for Anytown, Ergot, and other applications that
put a SMRT MCP HTTP surface on the public internet. SMRT currently supplies the
application-scoped `/api/mcp/tools` and `/api/mcp/call` adapters and a local
stdio bridge. It does **not** supply an OAuth authorization server or the MCP
Streamable HTTP transport. Until the stateless transport lands, terminate OAuth
at the application gateway and populate the authenticated SvelteKit principal
only after token validation.

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

For the current application adapters:

1. Protect both `/api/mcp/tools` and `/api/mcp/call` at the same gateway.
2. Validate the bearer token at the gateway and populate `event.locals.user`,
   `tenantId`, and permissions from the validated principal. Header presence is
   not authentication.
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
