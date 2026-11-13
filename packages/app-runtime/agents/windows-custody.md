# Windows custody (`packages/app-runtime`)

Windows has its own custody rule (README "Windows", smrt#4837), because Node
has no `O_NOFOLLOW`, uid, mode bits, or DACL access there: `windows-paths.ts`
(lexical), `windows-sddl.ts` (SDDL access decision), `windows-acl-inspector.ts`
(fixed-argv PowerShell, paths in the environment, ASCII JSON out, every
failure a refusal; no "unverified" mode), `windows-custody.ts` (synchronous
chain walk, creation with post-create re-inspection and rollback, bigint
identity). `windows-acl-lock.ts` (smrt#4843): a directory the runtime itself
creates (every component the call creates, intermediate ones included;
never one that already existed) is
locked at once through `WindowsCustodyRuntime.lockDirectory` (fixed-argv
`icacls.exe /inheritance:r /grant:r *user/SY/BA (OI)(CI)F`, path one argv
element) and then verified by the unchanged rule; a lock failure removes it.
The create-then-lock race is documented as a residual in the README; a
pre-existing directory is never re-permissioned and its refusal names the
extra principal. The fake machine's `lockMode` defaults to `record` so older
tests keep the inherited DACL; use `apply` to model icacls. Default root is `%LOCALAPPDATA%` only, never APPDATA or home.
Everything runs through `WindowsCustodyRuntime`; tests inject
`test-support/windows-fake-runtime.ts` with `runWithCustodyContext`
(`custody-context.ts`), never a public option. SQLite acquisition on Windows
runs through the SDK's `secureFile.windowsCustody.verify`
(`createWindowsDatabaseVerifier`, `windowsSecureFileCustody`; every place
that opens the secure database spreads it into `secureFile`); it throws, the
rule is unchanged. `smrt app backup|export|import` stay refused on Windows
for destination custody (packages/cli). Lease, state root,
`validateLocalDatabaseStorage` and acquisition work. SDDL writes the built-in RID-500
Administrator as `LA`: it is trusted (`ALIAS:LA`) only when the current
user's SID is a machine `S-1-5-21-…-500` SID (`trustedPrincipals`);
unverified on a real runner. `windows-custody.test.ts` runs anywhere;
`windows-custody.win32.test.ts` runs only in the advisory
`app-runtime-windows.yml` job.

## Windows sidecar startup diagnosis (#4954)

The launch lane installs a test home, starts the native wrapper, and the wrapper
passes its actual app-local directory plus `runtime` as `SMRT_DATA_DIR`. Its
working directory is the staged `target/debug/app`, separate from that data root.
For the current `home-AbCdEf` profile the root is 85 UTF-16 units under
`D:\a\_temp`, or 114 under `C:\Users\runneradmin\AppData\Local\Temp`.
Both fit W1's 130-unit root budget (240 minus 110 derived-file reserve). This
budget, the Windows custody policy and the inspector are unchanged from main
`f17400e42a`. There is no system-drive-only rule: D: is allowed when fixed NTFS
storage and the path/ACL rules pass. The POSIX-runnable smoke-layout regressions
attest only these rules, not the runner's actual permissions.

Startup sources of `LocalRuntimeError.code === 'invalid_configuration'`:

| Stage / owner | Refusals | Relevance to the launch lane |
| --- | --- | --- |
| `index.ts`: application ID, bootstrap/session TTL, owner-tenant configuration | Invalid explicit values | The generic host uses validated IDs and valid fixed defaults. Owner-claim inputs and embedded-runner configuration are later operations. |
| `index.ts` / `state-root.ts` / `windows-paths.ts`: path resolution | Missing LOCALAPPDATA, Windows aliases/devices/streams, path budgets, home/drive/source overlap | The modeled C:/D: smoke layouts pass; a different actual path must be checked from the wrapper's path diagnostics. Missing state LOCALAPPDATA is a plain Error. |
| `local-custody.ts`: read-only Windows preflight | Canonical source overlap; populated unmarked root; interrupted marker with unexpected files | Runs before acquiring the initialization lease. A genuinely fresh, separate root rules out marker collisions. |
| `windows-custody.ts`: chain walk and inspection | Missing drive, links/reparse points, changed/redirected path identities, wrong file kind, non-fixed/non-NTFS volumes, offline/cloud attributes | Fast failures are possible; a non-system drive alone is not a refusal. |
| `windows-sddl.ts`: security decision | Malformed/unsupported descriptor, foreign owner, unsafe ancestor replacement rights, extra custodial access | A temp profile introduces different ancestors from main's real-account profile. Actual runner SDDL is not known locally; do not relax the rule speculatively. |
| `windows-acl-inspector.ts`: attestation | Missing/blocked executable, immediate nonzero exit, malformed response, timeout | A timeout is ten seconds, but a failed script can exit immediately. Timing alone cannot exclude the inspector. |
| `windows-acl-lock.ts` / `windows-custody.ts`: private creation and reinspection | Locking failure, unsafe new directory/file, failed post-create identity or ACL checks | Reached after read-only preflight; pre-existing ACLs are never repaired. |
| `local-custody.ts`: initialization lease | Lease worker error/early exit/timeout, and the same path/creation checks | The acquisition error carries a non-enumerable cause; it is not limited to the two-minute timeout. |
| Database/marker/secret acquisition | The same custody checks before/after the SDK opens SQLite, dedicated-root marker and secret validation | First schema failures use `schema_creation_failed` or `migration_failed`; master-key failures use `secret_master_key_unavailable`, not this code. |

The test-state-base guard added on the branch throws a plain Error, not
`LocalRuntimeError`. Local-MCP input/scope validation, sign-in/owner inputs and
deployed-runtime validation do not execute on this fresh local startup path.
Session-cookie derivation reuses the same path resolver and adds no drive rule.
Dynamic-import/native-loader errors have different codes unless wrapped by a
listed custody/lease boundary.

The six suppressed lines in run `ci-4954f` cannot be recovered from that log.
The previous blanket redactor hid ordinary scoped file URLs, long path/function
names and error prose mentioning secrets. Its replacement preserves these and
masks only credential spans before truncation; the wrapper also logs the actual
working and data paths. Until Windows reruns, rank temp-tree ancestor custody,
path/volume identity, then an immediate inspector failure. None is a proven
runner diagnosis; no Windows security rule is changed on this evidence.
