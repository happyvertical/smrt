# Backup targets (#4804)

`smrt app backup --encrypted --target <name>` seals the data root into an
encrypted snapshot ([encrypted-snapshots.md](encrypted-snapshots.md)) and
stores it on a configured target. Targets only ever receive HVSF ciphertext.
Source: `src/app/backup-targets.ts` (contract), `backup-target-file.ts`,
`backup-target-gdrive.ts`, `backup-target-vault.ts`, and `backup-command.ts`
(configuration, orchestration, `smrt app backups`). All are exported from
`@happyvertical/smrt-cli/app`.

## Commands

```text
smrt app backups targets add <name> --kind file   --path <dir>            [retention]
smrt app backups targets add <name> --kind gdrive --credential <ref> [--folder <name>] [retention]
smrt app backups targets add <name> --kind vault  --url <https origin>    [retention]
smrt app backups targets [remove <name>]       list or forget (stored snapshots stay)
smrt app backups list   [--target <name>]      snapshots per target, newest first
smrt app backups prune  [--target <name>] [--dry-run]
smrt app backup --encrypted --target <name>    seal and store
```

Retention is per target: `--keep-last <n>` (at least 1) and optionally
`--keep-within-days <n>`. It runs after every successful upload and on
`prune`; the newest snapshot is never removed, ordering is by sequence (not by
clock), and a retention failure is reported without failing the finished
backup. A vault target without client retention is left to the relay, which
enforces its own after each commit. Retention always keeps the object the
backup just stored. If that object's sequence is not above the target's
existing maximum (a reinstalled or restored device whose counter restarted),
the report carries a `sequence_not_above_target_maximum` warning: ranking is by
sequence, so a later `prune` can still remove it; restore before backing up
again. `--target` requires `--encrypted`; there is
no plaintext path to a target.

Configuration is `<state root>/backup-targets.json` (0600): a directory, a Drive
folder and a credential *reference name*, or a relay URL. The parser rejects
every other field, so a token, key or password cannot be persisted by it. Target
directories must be outside the source tree and local storage; relay URLs must
be `https` (`http` for loopback only) with no path, query or credentials.
Targets are for the `local` profile.

## Seams (injected, fail closed when absent)

`AppCommandDependencies.backup` (`BackupTargetDependencies`):

- `credentials.driveCredentials(ref)` returns `{ clientId, clientSecret,
  refreshToken, scope }` from the user's own credential store (the custody
  seam). `credentials.vaultSigner()` returns `{ accountId, deviceId,
  sign(message) }`; the Ed25519 private key stays with its custodian.
- `entitlements` is `{ status() }` returning `featureKeys`; the device
  entitlement cache (#4787) satisfies it. Only the vault target reads it.
- `fetch`, `createDriveFilesystem` and `vault` tuning (chunking, retry and
  the lease's `leaseMonotonicNow` / `leaseTimers`) exist for tests and
  embedding. Snapshot keys come from `snapshotKeys` as before.

The vault key lifecycle (#4785) and the host supply these in production; this
package does not wire them, so Drive and vault targets report that nothing is
configured until they do. The local file target needs only `snapshotKeys`.

## Target contract

`put`, `list` (newest first), `get` (streamed), `delete`, and `preflight`
(entitlement, credentials, scope; runs **before** a snapshot sequence is spent).
`put` takes `{ sequence, byteSize, sha256, source }`; every target streams it
through `verifiedCiphertext`, which refuses anything whose clear HVSF header is
not valid for the declared sequence and checks the byte count and SHA-256, so a
plaintext archive can never reach a target. The backup stages ciphertext in a
0600 file under `<state root>/backup-staging/` (removed on success and failure)
because the relay needs the digest before the first byte.

- **File**: owner-only `.partial` sibling, fsync, size check, `link()` to
  `snapshot-<20-digit sequence>.hvsnap` (never replaces). The directory must
  belong to you and not be group/world-writable, and must not overlap the
  source tree, local storage or the state directory. `list` ignores partials,
  foreign names, and any file whose clear header does not carry the sequence in
  its name, so a planted name cannot steer retention; `prune` removes stale
  partials. Dedicate a directory to one application.
- **Google Drive**: through `@happyvertical/files`' Google Drive provider. The
  default folder is `smrt-backups-<hash of the app id>` because every SMRT app
  shares the OAuth client and `drive.file` shows each its siblings' files; give
  two apps the same `--folder` only if one's retention may remove the other's.
  Duplicate names (Drive allows them) make `list` and `put` fail with
  `integrity` until the extra copy is removed. Upload goes to `<folder>/staging/`, its stored size is checked, then one
  `move` publishes it into `<folder>/snapshots/` (the only folder listed).
- **Vault relay**: protocol `smrt-vault-relay-v1` (packages/vault-relay README).
  Begin, one signed `PUT` per chunk (each retried; the relay treats identical
  retries as idempotent), then commit, the only publishing step; any earlier
  failure aborts the upload. A commit whose answer is lost is reconciled by
  reading the snapshot back. The chunk size shrinks once to the relay's cap.
  Records are bounded before use (chunk size 1 KiB to 64 MiB, under 1,000,000
  chunks, larger than the clear header), so a hostile relay cannot make the
  client buffer or request without limit.
  - **Writer lease (#4805).** Every relay upload needs the primary-writer
    lease. `preflight` takes it (before a snapshot is sealed, so a device that
    is behind fails cheaply), `put` reuses it or takes its own, and `close`
    (called by `backupToTarget`) releases it. The target builds a
    `VaultLeaseKeeper` over its own signed requests with the installation's
    private state root (`vault-sync.json`): acquire at the recorded base
    sequence, send the fencing token in `begin`, renew before commit, and call
    `recordPublished` only after the relay confirms the commit. Refusals are
    `must_restore_first` (behind the account, or the lease was lost or taken:
    run `smrt app restore-latest`), `lease_held` (another device is writing or
    publishing) and `lease_lost`; none publishes anything. If the snapshot was
    published but the position cannot be recorded the error is
    `position_unrecorded`, and the next acquire is refused until a restore
    (fail safe). A failed attempt leaves `localWritesPending` set, which is
    conservative: `restore-latest` then needs `--discard-local` (the previous
    root is kept). `restoreProvider()` gives `restore-latest` its account, the
    lease routes and the latest-snapshot download over the same transport. It
    also needs the `accountTrust` option (revoked devices and the key
    generation floor of the adopted head); without it restore fails closed.

The vault target reports the relay's refusal to delete the sole committed
snapshot as `last_snapshot` and of the newest of several (the lease head) as
`head_snapshot`; they are distinct codes with distinct messages.

## Google Drive scope and limits

The scope is the one the credential store recorded from Google's token
response when the user consented; a store that records a narrower scope than
the token holds defeats the check, so it must record what Google returned. The
OAuth grant must be `drive.file` or `drive.appdata` and nothing else;
`drive`, `drive.readonly`, metadata scopes, an unrecorded scope, or a narrow
scope bundled with a wide one are refused before any request. The SDK
provider's list calls pass no `spaces=appDataFolder`, so only `drive.file` works
through it today; an app-data-only grant is refused with a clear message (the
preferred app-data scope needs SDK support). The provider reads and writes
whole buffers: a snapshot is held in memory up to 512 MiB, beyond which use the
file or vault target. Prune moves files to the Drive trash. Errors are fixed
text: an expired or revoked grant says to reconnect; a 403 or quota error says
storage may be full or access was removed (the SDK maps every 403 to one error,
so the two cannot be told apart). Provider text is never forwarded.

## Security properties and tests

| Threat | Control | Test |
| --- | --- | --- |
| Plaintext reaching a target | `verifiedCiphertext` header, sequence, size, digest check in every `put`; `--target` requires `--encrypted` | `backup-targets.test.ts` guard and per-target plaintext cases; `backup-command.test.ts` |
| Drive scope wider than needed | Allow-list of two app scopes, checked on every use; wide or bundled scopes refused before a call | `backup-targets.test.ts` scope |
| Tokens or keys in logs or config | Strict config parser, credential seam, fixed error text, no provider text | `backup-command.test.ts` no way to store a secret; Drive failure cases |
| Relay response confusion | Begin, chunk, commit and list answers checked against the request; downloads verified per chunk, whole digest, and header sequence; no redirects | `backup-targets.test.ts` relay response confusion |
| Partial upload published | Staged-then-published (file, Drive); begin/chunk/commit with abort (vault) | per-target interrupted-upload cases; `backup-client.test.ts` (vault-relay) |
| Publishing without, or after losing, the writer lease; a stale device overwriting a newer account | Fencing token in `begin`, renewal before commit, relay re-check at commit; `must_restore_first` publishes nothing and records nothing | `backup-targets.test.ts` primary-writer lease; `backup-client.test.ts` and `restore-e2e.test.ts` (vault-relay, real relay) |
| Entitlement bypass for the vault | Client check before any request or sequence; the relay gates every route from server-side grants | `backup-targets.test.ts` entitlement; `backup-client.test.ts` |

Residual risks: the client entitlement check is a courtesy (the relay is the
gate); Drive and the relay operator see ciphertext sizes and timing; the
relay's list and download answers are authenticated by TLS only, so rollback
protection is the caller's trusted sequence record (restore-latest, next
slice) and ciphertext authentication binds account, device and sequence; staged
ciphertext briefly doubles disk use.
