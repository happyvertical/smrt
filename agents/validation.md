# Validation checks

Use the Node/pnpm versions from root `package.json`; `pnpm install`, `pnpm build`.
On macOS, set `TMPDIR`, `TMP`, `TEMP`, and `CI_TEST_TMPDIR` to a writable
canonical directory such as `$HOME/Work/tmp/smrt-validation` before testing.
The `/var` alias can make lexical and physical paths disagree in route,
watcher, and secure SQLite custody tests.
Run package checks first, then the root gates:

- `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format-check`.
- `pnpm knowledge:check --strict --format markdown` (freshness; see
  [knowledge-artifacts.md](knowledge-artifacts.md)).
- `pnpm audit:policy` (dependency advisories). Dependency overrides target the
  advisory range; an ignored GHSA also needs an `audit-policy.json` record.
- `pnpm check:new-surface`: every new package, exports key, `_smrt_` table or
  `@smrt()` model needs a full `surface-ledger.json` entry.
- `pnpm check:node-roots`: built model roots load under plain Node (#4219);
  the allow-list is in root `package.json`.
- `pnpm check:redaction-ledgers`: the redaction rules ledgers of core and
  smrt-config only gain rows, with higher versions, against `origin/main` (or
  `$BASE_SHA`); CI runs it in "CI Control Plane Regression" (#5352).

CI's "Check Monorepo Standards" job also runs `scripts/check-*.mjs` that the
gates above do not cover. Locally: `pnpm check:standards`,
`pnpm check:no-smrt-peers`, `pnpm check:package-dag`,
`pnpm check:agents-chain`. The rest are listed in
`.github/workflows/on-pull-request.yml`; a surface-ledger miss was once found
only there (#5318).

Release automation generates changesets; never author them.

Lint/format, Vitest, Oxc, `svelte-check` gotchas: [root-gotchas.md](root-gotchas.md).
