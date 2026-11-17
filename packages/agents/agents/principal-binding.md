# PrincipalBinding server-set facts (#2944)

`PrincipalBinding` takes optional **server-set** `sessionId`, `credentialKind`
(`'session' | 'device' | 'api-key' | 'oauth' | 'service' | string`), and
`bindingMetadata` (JSON record). They reach `PrincipalRun` as:

- `run.sessionId` and `run.context.sessionId` (plumbed through
  `withPrincipalPermissionContext({ sessionId })`; `context.session` stays
  `null` — no session object is loaded or fabricated; absent means `null`),
- `run.credentialKind` (absent when not supplied),
- `run.bindingMetadata`: a frozen deep clone, so a run cannot mutate the
  binding (absent when not supplied).

Hosts must set these from verified server auth state, never from browser or
user input. They are descriptive passthroughs: they never feed `allowedTools`
(still fail-closed) or permission resolution. Use them instead of encoding
"how did this run authenticate" as a marker slug in `allowedTools`.
