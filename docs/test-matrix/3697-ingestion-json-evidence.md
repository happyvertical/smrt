# JSON source evidence regression (#3697)

Patch-class owning extraction repair for epic #3668. No schema/dependency/authority change; risk standard. Source adapters retain JSON email body/capture parts; treating these as unsupported makes composed extraction partial.

| Behavior/invariant | Reachable trigger | Positive case | Negative/failure | Actor/context | Executor/transaction | Runtime/dialect | External edge | Level/command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Preserve JSON as exact source evidence | Retained email/capture application/json part | Valid JSON returns exact text, evidence identity, source location and no automatic eligibility | Invalid JSON/UTF-8 fails without segments | Existing authenticated processing lease; parser grants no authority | Pure extraction; persistence unchanged | Node 26; SQLite/PostgreSQL integration unchanged | Built disposable adapter accepts same MIME | Unit `pnpm --filter @happyvertical/smrt-ingestion test`; provider `pnpm --filter @happyvertical/smrt-ingestion test:providers` |

Base sensitivity: run new JSON tests against unchanged parser, then fixed parser. Full affected ingestion SQLite/PostgreSQL/provider, build and types; relevant root static/knowledge/audit and normal hooks. Existing broad-root evidence covers unchanged packages; this patch changes only pure extraction MIME dispatch/validation and adds no database branch. Executed results recorded before review.

## Executed evidence

Node 26.10.0/pnpm11.25.0; captured logs and hashes: `/home/will/Work/tmp/s3697/validation.json`.

- New regression tests: old parser 3/3 fail with unsupported status; fixed parser 3/3 pass.
- Complete ingestion 77 tests, provider 9 tests, real ordinary-role PostgreSQL 54 tests pass.
- Frozen install, root build, package typecheck, root lint/format, strict knowledge, audit and agent-chain checks pass.
- No fresh broad root runtime/type result is claimed. This pure extraction parser change adds no schema, dependency or public signature; full owning suites plus root build/static gates cover affected behavior. Required PR CI remains an integration gate.
