# SMRT Vault Relay

Blind snapshot relay for the vault tier (#4799, epic #4668): a deployable
service storing encrypted snapshot blobs per account. See
[README.md](README.md) for the protocol, configuration, and deployment.

- **Blind by construction.** Never parse, decrypt, or validate blob content,
  never accept or store key material, and never log bodies, signatures,
  nonces, or account ids (log `accountHandle()` instead). Do not import the CLI
  snapshot framing; blobs are opaque bytes.
- **Order of checks** on every `/v1` route: route match, signature (shape,
  skew, active device of that account, Ed25519, then nonce), `backup.vault`
  entitlement via `requireFeature`, then the body digest and handler. Keep
  authentication failures a single uniform `401`.
- **Security properties are single conditional SQL statements** in
  `metadata-store.ts` (quota reservation, high-water advance, publish, nonce
  insert), portable across SQLite and PostgreSQL. Do not split them into
  read-then-write. Counter drift may only over-count.
- **Object keys** are derived (`v1/<account hash>/<upload uuid>/<index>.<object
  id>`, a fresh object id per write) and checked by `assertObjectKey`; never
  build one from a client string or overwrite a recorded object. Removal of a
  pending upload is conditional on `status = 'pending'`.
- **Schema** comes from `migrateVaultRelayV1` in the deployment migration
  step; request handling only checks table existence. No `@smrt()` models, so
  nothing gains generated REST, CLI, or MCP surfaces.
- **Owner inputs** (quotas, retention, bucket, databases, domain, namespace)
  have no defaults. Do not invent values; do not edit `happyvertical/iac`.

Tests run in-process on SQLite with the filesystem store;
`src/__tests__/postgres.optional.test.ts` runs under `pnpm test:postgres`.
