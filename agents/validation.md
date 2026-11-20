# Validation checks

Use the Node/pnpm versions from root `package.json`; `pnpm install`, `pnpm build`.
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

CI's "Check Monorepo Standards" job also runs `scripts/check-*.mjs` that the
gates above do not cover. Locally: `pnpm check:standards`,
`pnpm check:no-smrt-peers`, `pnpm check:package-dag`,
`pnpm check:agents-chain`. The rest are listed in
`.github/workflows/on-pull-request.yml`; a surface-ledger miss was once found
only there (#5318).

Release automation generates changesets; never author them.
