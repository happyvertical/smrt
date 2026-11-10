# Intent-driven duplicate detection (#4690)

`review-smrt-project` parses the intent index at runtime
(`intent-index.ts`, pure) and `intent-detector.ts` evaluates each row's signals;
no intent is named in code, so a new row with signals needs no change here.
Trust boundary: `regex:` tokens become `RegExp`, so rules are never read from the
reviewed tree. Index lookup: `intentIndexPath` / `--intent-index` (trusted by the
caller), else the full unfiltered index shipped in this package's
`dist/knowledge/intents/` (`scripts/ship-knowledge-pages.mjs`, list
`OKF_INTENT_HOME_PACKAGES`), else the monorepo `docs/knowledge/intents/index.md`
when run from the smrt checkout. The exported consumer bundle index is filtered
to installed packages and is not consulted. Tokens:
`import:<module>`, `call:<ident>`, `regex:<pattern>`, and
`decimal-field:<glob>` (a property matching the glob declared with a decimal
literal or `type: 'decimal'`). Unknown kinds are skipped with a stderr note. A
finding needs a signal and no import of any row home package in the same
package; it is advisory (`area: duplicate-detection`, `file: path:line`,
`intentPage`, `componentPages`). Fixtures live in `test-fixtures/` (outside
`src/`, so tsc, Biome, and vitest globs never see them).

`smrt-dev-mcp review --directory . [--intent-index P] [--format summary]
[--fail-on-findings]` runs the pass from a shell (exit 2 with a stderr message when
no index is found; the tool reports `skipped` with a note). The reusable
`.github/workflows/consumer-knowledge-review.yml` calls it through the pinned
published package (public on npmjs, so private consumers need no token), has no
index input, and writes the summary to `$GITHUB_STEP_SUMMARY`.
