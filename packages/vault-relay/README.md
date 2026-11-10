# s-m-r-t Vault Relay

`@happyvertical/smrt-vault-relay` is the server side of the vault tier: a blind
snapshot relay. It stores encrypted snapshots per account, in a monotonic
sequence, and can never read or validate their content. Devices encrypt with a
user-held key before upload (see the encrypted snapshot format in
`smrt app backup --encrypted`); the relay sees sizes, dates, sequences, and
SHA-256 digests of ciphertext only, and holds no key material.

Every device route is authenticated by an Ed25519 device signature and then
gated by the `backup.vault` feature (`requireFeature` from
`@happyvertical/smrt-features`), resolved server-side from the account's plan
grants and overrides. A client cannot claim the entitlement. When the
entitlement lapses, writes stop at once but restores stay open for a
retention window; see [Lapsed subscriptions](#lapsed-subscriptions).

This package deploys as a container. It is not deployed by this repository:
hosting is configured in `happyvertical/iac` from the inputs listed under
[Required configuration](#required-configuration).

## Device API

All `/v1` routes need the signature headers below. Bodies are JSON or raw
ciphertext; responses are JSON unless noted.

| Route | Purpose |
| --- | --- |
| `GET /v1/lease` | Primary-writer lease state: `{ holder, expiresAt, headSequence, latestCommittedSequence, headIsHole }`. Never the token. |
| `POST /v1/lease/acquire` | `{ baseSequence, ttlSeconds? }`. Grants `{ fencingToken, expiresAt, ttlMs, headSequence }`, or `409 must_restore_first`, `lease_held`, `publish_in_progress`. |
| `POST /v1/lease/renew` | `{ fencingToken, ttlSeconds? }`. Extends an unexpired lease; `409 lease_lost` otherwise. |
| `POST /v1/lease/release` | `{ fencingToken }`. `204`; a wrong token changes nothing. |
| `POST /v1/uploads` | Begin an upload: `{ fencingToken, sequence, byteSize, chunkSize, sha256 }`. Needs the lease. Reserves quota. Returns `uploadId`, `chunkCount`, `expiresAt`. |
| `PUT /v1/uploads/:uploadId/chunks/:index` | Upload one chunk. Every chunk except the last is exactly `chunkSize` bytes; the request must carry that exact `Content-Length`. A stored chunk is never replaced: an identical retry answers 200, different bytes `409 chunk_exists`. |
| `POST /v1/uploads/:uploadId/commit` | Publish. The relay checks every chunk is present and the SHA-256 of the whole ciphertext matches the declared digest, then atomically makes it the newest snapshot. |
| `DELETE /v1/uploads/:uploadId` | Abort a pending upload and release its quota. |
| `GET /v1/snapshots` | Committed snapshots, newest first. |
| `GET /v1/snapshots/latest` | The newest committed snapshot. |
| `GET /v1/snapshots/:sequence` | Metadata of one committed snapshot. |
| `GET /v1/snapshots/:sequence/chunks/:index` | Chunk bytes (`application/octet-stream`, `x-vault-chunk-sha256`). |
| `DELETE /v1/snapshots/:sequence` | Delete a committed snapshot. The sequence stays used. The account's last committed snapshot is refused with `409 last_snapshot`; delete only while another committed snapshot remains. The head (an in-flight or latest publish position) is refused with `409 head_snapshot`; delete only below both. |
| `GET /healthz`, `GET /readyz` | Liveness, and readiness (schema present, object store reachable). No authentication. |

Rules the relay enforces:

- **Sequences are monotonic.** A new upload must use a sequence above every
  sequence ever published for the account, including deleted ones. A commit
  fails with `409 stale_sequence` if a higher sequence was published first, and
  that upload is discarded. Two uploads cannot share a sequence.
- **Sequences cannot jump far.** The device picks its sequence and a commit
  raises the high-water mark for good, so a begin or commit more than
  `maxSequenceJump` above the current mark (default **1000**, a safe default
  chosen here, not an owner input; set `VAULT_RELAY_MAX_SEQUENCE_JUMP`) is
  `400 sequence_too_far` with `highWaterSequence` and `maxSequenceJump`. A
  brand-new account starts from a mark of 0, so its first sequence is at most
  the cap. One commit at the largest safe integer can therefore no longer
  make every later upload `stale_sequence`.
- **One primary writer per account** (#4805). Publishing needs the lease,
  and the lease is granted only to a device whose `baseSequence` is the
  account's head, so a device that is behind must restore first; there is no
  merge. See [Primary-writer lease](#primary-writer-lease).
- **Publish is atomic.** Pending uploads are never listed, never `latest`, and
  never downloadable. Abandoned uploads expire after the upload TTL.
- **Quotas count pending uploads.** Bytes and snapshot count are reserved when
  an upload begins (`413 quota_exceeded`) and released on abort, expiry,
  deletion, and retention.
- **The last snapshot stays.** A device cannot delete the only committed
  snapshot of its account (`409 last_snapshot`), so a compromised or mistaken
  device cannot erase the one restorable copy. Both the refusal
  (`snapshot_delete_refused`) and every successful device delete
  (`snapshot_deleted`) are logged with the hashed account handle, the device id
  and the sequence. The operator can still remove snapshots through the admin
  high-water reset. Two devices deleting the final two snapshots in the same
  instant can both pass on PostgreSQL (each sees the other); retention always
  keeps at least one.
- **Retention** runs after each commit: the newest `keepLast` committed
  snapshots are kept, plus any committed within the age window. Snapshots
  inside the window count against the snapshot quota, so choose
  `maxSnapshots` above the number of backups an account makes per window plus
  one, or new uploads are refused until older snapshots age out.
- **Bounded requests.** Chunk size is capped (default 8 MiB plus 64 KiB, hard
  ceiling 64 MiB), JSON bodies at 4 KiB. A body without `Content-Length`, or
  with the wrong one, is refused before it is buffered.

### Primary-writer lease

One lease row per account names the holder device, a fencing token, an
expiry on the relay clock, and `headSequence`, the sequence the account's
data line is at. Every decision is one conditional statement on that row.

- **Acquire** succeeds when the lease is free, expired, or already the
  caller's, and `baseSequence` is the head with no upload pending at the head,
  or, when the head's upload was abandoned (a *hole*), the latest committed
  sequence. Every grant, including a re-acquire by the same device,
  increments the fencing token, which fences an earlier process of that
  device too. Refusals: `must_restore_first { headSequence, latestSequence }`,
  `lease_held { holder, expiresAt }`, `publish_in_progress { headSequence }`.
- **Renew** needs the holder, the current token, and an unexpired lease.
  **Release** needs the holder and the current token. Revoking a device clears
  any lease it holds and bumps the token.
- **Publish.** Begin records the caller's token with the upload and refuses
  (`must_restore_first`) a caller that is not the unexpired holder with that
  token or whose sequence is not above the head. That begin check is
  advisory; commit enforces: after the digest check it advances the head
  only for the holder with the recorded token, while the upload is still
  pending, forward under an unexpired lease (or, for a retried commit, a head
  already at that sequence). A refused commit discards the upload and answers
  `409 must_restore_first`.
- **Deletes** never remove the head or the latest committed snapshot, so a
  head without a row is always an abandoned upload, never deleted data.

The lifetime is `VAULT_RELAY_LEASE_TTL_SECONDS` (default 300, 30 to 3600); a
client may ask for less with `ttlSeconds`. Clients judge expiry from `ttlMs`
on their own monotonic clock, never by comparing `expiresAt` with local time.

### Account supersession

After a family restarts its vault because the recovery secret is lost
(`@happyvertical/smrt-app-runtime`, vault key lifecycle `restartAccount`), the
account layer creates a new account and replaces the old one. The relay
records only the replacement; it still cannot read anything.

A replaced account answers `409 account_superseded` (no other detail, and
never the new account's id: a client does not follow the relay to another
account) to every device route that writes or offers a snapshot: lease
acquire and renew, begin, chunk upload, commit, snapshot delete, list,
latest and lease status (the refusal on lease status is how a device proves,
before it follows the new account, that the old one was replaced). Lease
release, aborting an upload, and a snapshot's metadata and chunks by explicit
sequence stay available, so state can be cleaned up and a snapshot rescued by
hand. A stale device on the old account
therefore stops publishing into a line nobody follows, and restore-latest is
never handed the old vault. The new account is unaffected.

Only the admin listener sets or clears it, so a stolen device key cannot
silence or redirect an account. The account layer must re-authenticate the
human owner first. The `DELETE` is for an operator mistake or a restart that
never reached the working device; it does not undo a device that already ran
`restartAccount`, which has no local undo. The replacement must already hold an active
device and must not be replaced itself, so there are no chains or loops.
Existing snapshots stay until an operator deletes them.

### Request signing

Each request carries `x-vault-account`, `x-vault-device`, `x-vault-timestamp`
(unix milliseconds), `x-vault-nonce` (16 to 64 base64url characters, single
use), `x-vault-content-sha256` (hex SHA-256 of the exact body; the empty-body
digest for bodiless requests), and `x-vault-signature`: the base64url Ed25519
signature over

```text
smrt-vault-relay-v1
<METHOD>
<path and query, as the server parses it>
<account id>
<device id>
<timestamp>
<nonce>
<body sha256>
```

`signRelayRequest()` builds these headers. Requests are rejected with one
uniform `401 unauthorized` when a header is missing or malformed, the
timestamp is outside the clock-skew window (default 5 minutes), the device is
unknown, revoked, or registered to another account, the signature does not
verify, or the nonce was used before. A body whose digest differs from the
signed digest is rejected with `400 content_digest_mismatch`. Account and
device ids match `[A-Za-z0-9][A-Za-z0-9_-]{0,127}`.

Entitlement denials answer `403` with the structured body from
`smrt-features` (`feature_upgrade_required` naming the granting plan, or
`feature_disabled`). If the entitlement lookup itself fails, the relay answers
`503 entitlement_unavailable`: it fails closed. An account that never held the
entitlement, or whose entitlement an operator disabled, is refused on every
route. An account that held it and stored snapshots is *lapsed*:

### Lapsed subscriptions

Owner decision #4819. When `backup.vault` lapses for an account that holds
committed snapshots:

- The relay records the lapse time the first time it observes it (a device
  request, or the operator sweep's discovery pass). The time is kept, never
  moved, and cleared when the entitlement is active again.
- **Writes are refused** (`begin`, chunk upload, commit, device snapshot
  delete) with `402 entitlement_lapsed` and `{ lapsedAt, restoreAvailableUntil }`.
  This code differs from the `403` upgrade/disabled denials and from the `401`
  authentication failure.
- **Reads stay open** for authenticated devices of the account: list,
  `latest`, snapshot metadata and chunk download, aborting an upload, and the
  lease routes (restore-latest holds the lease while it downloads).
- After `lapseRetentionDays` (default **90**, `VAULT_RELAY_LAPSE_RETENTION_DAYS`,
  1 to 3650) reads answer `410 retention_expired` and the account is eligible
  for the sweep. Writes keep answering `402 entitlement_lapsed`.
- **The sweep is an operator action, not a device action.**
  `POST /admin/v1/lapse-sweep` (admin token) with `{ dryRun?, limit?, cursor? }`
  and an optional `x-vault-operator` label header. Per run it handles at most
  `limit` accounts (default 10, at most 100) in two phases: a discovery pass
  over accounts with snapshots but no lapse record (resume with the returned
  `nextCursor`), which starts the window for lapses no device reported; and a
  deletion pass over lapses whose window has elapsed. Each account is
  re-checked first: one that is entitled again keeps its data and has its
  lapse cleared. Deletion uses the normal removal path (rows, counters,
  objects). Every deleted account writes a `lapse_sweep_started` and a
  `lapse_sweep_completed` record to the append-only `vault_relay_audit` table:
  time, operator (label plus a fingerprint of the admin token, never the
  token), hashed account handle, snapshot count and bytes. Re-running is
  idempotent; a run that crashed mid-account is finished by the next one. A
  dry run reports the same result and changes and audits nothing. A sweep
  leaves the account's high-water mark and lease head as they were.

## Admin API (account layer and operator)

Served on a separate listener, which must stay cluster-internal, and only when
`VAULT_RELAY_ADMIN_TOKEN` is set. Requests use `Authorization: Bearer <token>`.

| Route | Purpose |
| --- | --- |
| `PUT /admin/v1/accounts/:account/devices/:device` | Register a device key: `{ publicKey }` (raw 32-byte Ed25519 key, base64url). Idempotent for the same key. A revoked id, or a different key under an existing id, is `409`. |
| `DELETE /admin/v1/accounts/:account/devices/:device` | Revoke a device. Effective on its next request. |
| `GET /admin/v1/accounts/:account` | Usage, snapshot sizes and dates, device states. Never content. |
| `POST /admin/v1/accounts/:account/high-water` | Reset the sequence high-water mark of an account whose mark was pushed out of reach: `{ highWaterSequence, removeSnapshotsAbove? }`. The new mark may not exceed the current one. A snapshot or pending upload above it is refused (`409 snapshots_above_high_water`, sequences listed) unless `removeSnapshotsAbove` is `true`, which deletes those rows and their objects first. Logged as `high_water_reset` (hashed account handle, previous and new mark, removed sequences). |
| `PUT /admin/v1/accounts/:account/superseded-by` | Replace an account (#4817): `{ supersededBy }`. For the account layer at the start of a vault restart, as soon as the new account exists with an active device (before the first backup into it): from then on a stale device cannot publish into the old line. `201` set, `200` repeated, `404 no_account`, `409 target_not_ready` (no active device), `409 target_superseded` or `409 account_is_target` (no chains or loops), `409 already_superseded` (another target). See [Account supersession](#account-supersession). |
| `DELETE /admin/v1/accounts/:account/superseded-by` | Undo it, for an operator mistake. `204`, or `404 no_supersession`. |
| `POST /admin/v1/accounts/:account/reconcile` | Recompute quota counters from snapshot rows. Run it while the account is quiet: a reconcile racing an upload can under-count until the next reconcile. |
| `POST /admin/v1/sweep` | Expire abandoned uploads and old nonces (also runs every minute). |
| `POST /admin/v1/lapse-sweep` | Audited deletion of lapsed accounts' snapshots after the retention window (#4819). `{ dryRun?, limit?, cursor? }`; see [Lapsed subscriptions](#lapsed-subscriptions). |

The same hooks are available in-process: `relay.registerDevice()`,
`relay.revokeDevice()`, `relay.operatorView()`.

## Storage

Chunk bytes live in an object store under relay-derived keys,
`v1/<sha256 account handle>/<upload uuid>/<index>.<random object id>`; no
client string becomes part of a key. Each write attempt gets its own object,
and a chunk row is recorded only while its upload is still pending, so a write
that lands after an abort, expiry, or publish is deleted instead of counted. `FilesystemObjectStore` (atomic temp-and-rename writes) serves
tests and single-node development. `createS3ObjectStore()` uses the
`@happyvertical/files` S3 provider with path-style addressing for Garage.

Metadata lives in the service database (SQLite or PostgreSQL) in ten
`vault_relay_*` tables. `migrateVaultRelayV1(db)` and
`migrateVaultRelayLeasesV1(db)` create them idempotently.
Run it as the deployment's migration step (`node dist/cli.js migrate`); the
server checks the tables exist at readiness and never creates schema while
serving.

**Upgrading to account supersession (#4817).** `migrateVaultRelayV1` now also
creates `vault_relay_supersessions`. Re-run the migration job (it is
idempotent) **before** deploying this version: until the table exists,
`/readyz` reports `schema_missing` and the relay is not ready, and every
device route that checks supersession (backup, restore, lease acquire and
renew) fails.

**Upgrading to the lapse window (#4819).** `migrateVaultRelayV1` also creates
`vault_relay_lapses` and `vault_relay_audit` (plain `CREATE TABLE IF NOT
EXISTS`, no change to existing tables). Re-run the migration job before
deploying this version; until then `/readyz` reports `schema_missing`.

## Required configuration

These are owner inputs. The relay has no defaults for them and refuses to start
without them (except the admin token, see its row). Values are not chosen here.

| Variable | Meaning |
| --- | --- |
| `VAULT_RELAY_DATABASE_URL` | Relay metadata database (`postgres://…`, or a SQLite path). Secret. |
| `VAULT_RELAY_ENTITLEMENTS_DATABASE_URL` | Database holding the platform's feature and subscription tables, read for `backup.vault`. May equal the relay database. Secret; read-only access suffices. |
| `VAULT_RELAY_STORAGE` | `s3` in deployment (`filesystem` for development). |
| `VAULT_RELAY_S3_BUCKET` | Garage bucket for ciphertext. |
| `VAULT_RELAY_S3_ENDPOINT` | Garage S3 endpoint URL. |
| `VAULT_RELAY_S3_REGION` | Region name the Garage cluster is configured with. |
| `VAULT_RELAY_S3_ACCESS_KEY_ID`, `VAULT_RELAY_S3_SECRET_ACCESS_KEY` | Bucket-scoped Garage key. Secret. |
| `VAULT_RELAY_QUOTA_MAX_BYTES` | Per-account byte quota (committed plus pending). |
| `VAULT_RELAY_QUOTA_MAX_SNAPSHOTS` | Per-account snapshot quota (committed plus pending). Must exceed `KEEP_LAST`. |
| `VAULT_RELAY_RETENTION_KEEP_LAST` | Newest committed snapshots always kept (at least 1). |
| `VAULT_RELAY_RETENTION_KEEP_WITHIN_DAYS` | Also keep snapshots committed within this many days (0 for none). |
| `VAULT_RELAY_ADMIN_TOKEN` | Admin bearer token, at least 32 characters. Secret. Optional to the process: without it the admin listener does not start, so the account layer cannot register devices. |

Optional technical settings: `VAULT_RELAY_PORT` (8080), `VAULT_RELAY_ADMIN_PORT`
(8081), `VAULT_RELAY_MAX_CHUNK_BYTES` (8454144), `VAULT_RELAY_UPLOAD_TTL_SECONDS`
(86400), `VAULT_RELAY_MAX_CLOCK_SKEW_SECONDS` (300), `VAULT_RELAY_MAX_SEQUENCE_JUMP` (1000),
`VAULT_RELAY_LEASE_TTL_SECONDS` (300), `VAULT_RELAY_LAPSE_RETENTION_DAYS` (90, 1 to
3650). With `VAULT_RELAY_STORAGE=filesystem`,
`VAULT_RELAY_STORAGE_PATH` is required.

The deployment also needs, from the owner: the namespace, the public domain and
TLS for the device API, the image registry and digest, and network policy that
keeps the admin port private. The device Ingress must accept request bodies of
at least the maximum chunk size plus headroom: with the default 8 MiB + 64 KiB
chunks, set the ingress body limit to at least `9m` (`10m` in the `smrt-app`
chart's allowed set; ingress-nginx defaults to `1m`). Keep
`VAULT_RELAY_MAX_CHUNK_BYTES` below the ingress limit the chart permits.

## Deployment

`packages/vault-relay/Dockerfile` builds the image from the repository root:

```sh
docker build -f packages/vault-relay/Dockerfile -t <registry>/smrt-vault-relay:<version> .
```

The image runs as `node`, listens on 8080 (device API) and 8081 (admin API),
and takes `serve` (default) or `migrate` as its command. For the `smrt-app`
chart (see the [deployment guide](../../docs/content/deployment.md)), model it
as:

- one `web` workload, `writer: true`, command `["node", "dist/cli.js", "serve"]`,
  port 8080, `readinessProbe` `GET /readyz`, `livenessProbe` `GET /healthz`,
  every variable above from named, immutable Secret keys, and a pod and
  container security context that is non-root with a read-only root
  filesystem (the relay writes nothing locally with S3 storage);
- the migration job with command `["node", "dist/cli.js", "migrate"]` and only
  `VAULT_RELAY_DATABASE_URL`. The DDL is idempotent; the chart's
  `smrt-release-v1` wrapper requirements still apply and are an adoption task;
- the admin port exposed only through a cluster-internal Service, never the
  Ingress.

The relay keeps no state on local disk with S3 storage, so replicas can scale
horizontally: every security check is a conditional database statement.

## Security model

| Threat | Control | Test |
| --- | --- | --- |
| Unauthenticated or replayed request | Ed25519 signature over method, path, account, device, timestamp, nonce, body digest; skew window; primary-key nonce table | `relay.test.ts` authentication |
| Revoked device, or another account's device | Device lookup by (account, device), active only; ids never reused | `relay.test.ts` authentication |
| Cross-account access | Every query scoped by the authenticated account; uploads looked up by (account, upload) | `relay.test.ts` cross-account isolation |
| Quota or size abuse | Atomic conditional reservation; declared length checked before buffering; chunk cap | `relay.test.ts` quotas and request bounds |
| A device erasing the only restorable snapshot | Conditional delete only while another committed snapshot exists; refusal and removals audited by device and sequence | `relay.test.ts` device deletes |
| Partial upload becoming latest | Pending status; commit verifies every chunk and the whole digest | `relay.test.ts` atomic publish |
| Sequence rollback or overwrite | Account high-water mark advanced conditionally; unique (account, sequence) | `relay.test.ts` atomic publish |
| One commit pins the high-water mark out of reach, so every later upload is stale | Step cap at begin and inside the advance statement; operator reset on the admin listener, audited | `relay.test.ts` sequence step cap and high-water reset |
| Entitlement bypass, off plan | `requireFeature('backup.vault')` per request from server-side grants; fails closed | `entitlements.test.ts` |
| Writing after the plan lapsed; data lingering forever, or a family locked out of its own data (#4819) | Writes `402 entitlement_lapsed`; reads open for `lapseRetentionDays` from the first observed lapse, then `410`; audited operator sweep deletes | `lapse.test.ts` |
| Leakage through logs, listings, or storage | Logs carry route, status, and a hashed account handle only; operator view is sizes and dates | `blind-operator.test.ts` |
| Two devices publishing divergent lines | Lease row: one holder, base must be the head, head advanced at commit only by the holder's recorded fencing token | `lease.test.ts` |
| Lease theft or reuse after expiry; stale fencing token | Holder and token must both match; relay-clock expiry; token bumped on every grant and on revocation | `lease.test.ts` expiry and takeover, re-acquire fencing |
| Replayed acquire | Signed nonce and timestamp | `lease.test.ts` replay |
| A stale device keeps publishing into a replaced account, or restore-latest is offered the old vault (#4817) | Admin-set supersession; writes, list and latest refuse with `409 account_superseded` | `supersession.test.ts`, `restore-e2e.test.ts` restarted account |
| A stolen device silences or redirects an account | Supersession exists only on the admin listener; the refusal names no other account | `supersession.test.ts` set by the account layer only |
| Supersession chains or loops | Target must have an active device and must not be replaced | `supersession.test.ts` target checks |
| Path traversal in object keys | Keys derived from hash, server UUID, and index; regex and containment checks | `storage-and-config.test.ts` |

Residual risks: a publish whose head advanced but whose commit was never
retried blocks other devices' acquire (`publish_in_progress`) until the
upload TTL expires; the relay is trusted to name the latest snapshot to a
device with no local history (a device with history refuses anything below
the highest sequence it has seen). An operator can see ciphertext sizes, timing, and device ids
(an HVSF snapshot also carries its producing device id, key id, generation, and
length in a clear file header that the relay stores but never parses);
quota counters can over-count after a crash between steps (`reconcile`
repairs it); a crash between storing a chunk object and recording it can leave
one unreferenced ciphertext object.

## Development

```sh
pnpm --filter @happyvertical/smrt-vault-relay test
pnpm --filter @happyvertical/smrt-vault-relay typecheck
pnpm --filter @happyvertical/smrt-vault-relay test:postgres   # needs a CI PostgreSQL URL
```
