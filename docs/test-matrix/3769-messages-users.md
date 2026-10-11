# Messages and users help (#3769)

Risk: standard. Changes add explanations only; operations, visibility, persistence,
tenancy, and authorization are unchanged. Coordinator owns integrated review/release.

| Behavior / invariant | Reachable trigger | Positive case | Negative / failure case | Actor / context | Executor / transaction | Runtime / dialect | External edge | Level | Validation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Displayed recipe fields have useful glossary explanations | Scanner emits mailbox, sign-in and roles recipes; help renderer builds glossary | Every displayed field has an explanation, including inherited fields | Hidden and sensitive fields never enter glossary | Visitor, default and advanced help | N/A: pure metadata | Node; SQL N/A | N/A: no provider requests | Integration | Package Vitest recipe-help.test.ts |
| Help references survive default visibility | Render recipe tasks | Membership role guidance remains visible | Hidden tenant field is not referenced; hiding referenced field drops its task | Visitor / host field policy | N/A: pure rendering | Node; SQL N/A | Missing field is pruned | Integration | Package Vitest recipe-help.test.ts |
| Visitor copy describes account tasks | Read rendered sign-in help | Sessions and recovery use visitor language | No API/MCP jargon or sensitive fields | Visitor | N/A: prose | Node; SQL N/A | N/A | Integration | Users Vitest recipe-help.test.ts |

## Evidence

Toolchain: Node 26.9.0, pnpm 11.25.0; all scratch variables point to
`/home/will/Work/tmp/smrt-ui`. Evidence logs are in
`/home/will/Work/tmp/smrt-3719-evidence/messages-users`.

- Base regression: `base-messages-node26.log` fails on the empty Email.accountId
  glossary; `base-users-node26.log` fails on missing Role.name, the referenced
  membership field glossary, and API/MCP sign-in prose. The original tracked
  source was restored for these runs, then the changes were reapplied.
- Own-package `build`, `typecheck` (including Svelte accessibility), and
  `verify:pack` pass for users and messages (`build-final.log`, `typecheck-final.log`,
  `pack.log`).
- Scanner field metadata compared with baseline manifests: no differences after
  removing description text (types, relationship targets, required/unique flags,
  and sensitive metadata remain identical; `metadata-preservation.log`).
- Users full suite: 50 files / 721 tests pass; 13 environment-gated files /
  58 tests intentionally skipped (`test-users.log`). The final expanded recipe
  regression passes all four tests (`test-users-regression-final.log`).
- Messages full suite: 24 files / 296 tests pass; three environment-gated files /
  19 tests intentionally skipped (`test-messages-final.log`). The prior concurrent
  run hit five existing 10-second setup limits (`test-messages.log`); the complete
  rerun passes with unchanged timeout limits after competing suites finish.
- Biome passes for all touched TypeScript (`biome.log`).
- Regenerated package artifacts and root graph pass the strict changed-file
  knowledge check (`knowledge-check-final.log`). The copied ingestion artifact
  was regenerated from this worktree's unchanged baseline README; no tracked
  ingestion files were changed.

No UI components or database behavior change; the existing package suites retain
those contracts. PostgreSQL-only suites remain environment-gated because no
persistence, principal context, or authorization behavior changed. Inherited
mailbox timestamp explanations use recipe help options without changing visibility.
Coordinator owns integrated review and release.
