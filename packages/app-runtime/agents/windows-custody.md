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
