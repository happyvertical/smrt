# #4413 SQLite explicit NOT NULL relaxation

Dependency of #4412, session hearth-photo-first-20261026, same local-only branch,
separate commit. Root owns integration/lifecycle. No original-user DB or containers.

Named high risk: destructive table rebuild / migration data integrity. Existing
rebuild owns row/FK/index/trigger preservation and transaction rollback; extend
only explicit supported nullability relaxation, retaining default fail-closed mode.

- Red: populated SQLite required workbook-like FK, new nullable manifest,
  relaxColumns enabled; generated migration currently remains manual/advisory.
- Green: actual manifest diff/executable migration/re-diff converges nullable
  without manual SQL; legacy rows and referenced attempt/revision/grade rows intact.
- Preserve indexes (including partial), triggers, FKs/UUID declarations and row
  identity; new nullable insert succeeds, unrelated constraints remain enforced.
- Default without relaxation opt-in remains advisory/refused; unknown rebuild
  shapes fail closed; forced failure rolls back schema and data atomically.
- Supported app/db migration operation lock/options and repeat-idempotency proof;
  no runtime domain DDL. PostgreSQL/DuckDB existing behavior regression tests.
- Root later tests old education schema upgrade through the installed app runtime
  and verifies private files unchanged, then retries retained work.

## Worker evidence (2026-10-26)

Logs: `/Users/will/Work/tmp/hearth-photo-first-20261026/evidence/4413/`.
Commands use Node v26.10.0 on PATH. No builds, containers or original databases.

- Red: `pnpm --filter @happyvertical/smrt-core exec vitest run src/migrations/__tests__/issue-4413-sqlite-relaxation.test.ts` — exit 1; four failing cases before implementation (`red.log`).
- Green: `pnpm --filter @happyvertical/smrt-core exec vitest run src/migrations/__tests__/issue-4413-sqlite-relaxation.test.ts src/migrations/__tests__/sqlite-table-rebuild.test.ts src/migrations/__tests__/issue-2369-nullability-default-drift.test.ts src/migrations/__tests__/orchestrate.test.ts src/migrations/__tests__/tracker.test.ts src/migrations/__tests__/tracker-branches.test.ts` — exit 0; 141 tests / six suites (`core-focused.log`). Includes existing PostgreSQL/DuckDB comparer cases; no live external PostgreSQL.
- `pnpm --filter @happyvertical/smrt-core typecheck` — exit 0; source and test TypeScript (`typecheck.log`).
- `pnpm --filter @happyvertical/smrt-cli exec vitest run src/app/__tests__/operations.test.ts` — exit 0; 67 tests, including explicit flag forwarding and rejected unknown arguments (`cli-focused.log`).
- Scoped `pnpm exec biome check --write <owned TypeScript files>` — exit 0 (`format.log`); `git diff --check` — exit 0.

The populated SQLite fixture preserves assigned rowid 42 and required workbook FK,
partial index, trigger, CHECK/default text and attempt/assessment/grade sentinel
rows. It runs manifest diff -> MigrationTracker atomic apply -> re-diff -> nullable
insert, plus programmatic orchestration with repeat no-op. Forced SQL failure and
orphan insertion roll back schema/data; active transactions, ineffective PRAGMA,
mismatched transaction connection, missing transaction support and AUTOINCREMENT
sequence tables fail closed. FK and legacy rename settings restore to prior values.
Application migration remains under its existing operation lock/writer refusal;
root owns installed-app old-schema acceptance, full gates and integrated review.
