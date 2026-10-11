# Exact cost billing (#3793)

Risk: high — public financial arithmetic with signed inputs. Pure additive API;
no persistence, actor authorization, transaction, dialect or external service:
these matrix dimensions are N/A because all execution is local deterministic
TypeScript with BigInt. Runtime: Node and browser ES2020+. Caller selects policy.

| Behavior / reachable trigger | Positive | Negative / failure | Level / command |
| --- | --- | --- | --- |
| Cost mode selected by caller | principal once, fee only, no charge modes; signed symmetry | unknown mode; unsafe amount; overflow | unit / commerce test |
| Ordered policy overrides | first defined rate, explicit zero, retained provenance | absent rate; malformed shadowed rate and provenance | unit / commerce test |
| Exact bounded percent | fractional precision and half ties | numeric, exponent, whitespace, excess scale/range | unit / commerce test |
| Explicit tax mapping and scope | two 10-unit lines at 5%: line 2 vs invoice 1; mixed categories/components; signed reversal | missing category; duplicates; unknown scope; overflow | unit / commerce test |
| Independent public export | built package self-import without models/Svelte, Chromium module execution | export missing or incorrect, hidden server dependencies | contract / commerce test and test:e2e |
| Existing invoice behavior | existing invoice calculations and package/UI tests unchanged | regressions remain failures | full commerce test and test:e2e |

Validation logs live outside the worktree under
`/home/will/.local/state/happyvertical/tradeschief-277-release1/commerce`.
This adds a contract, not a bug fix; base-failure comparison is N/A.

## Executed evidence

- `pnpm install`: pass (`install.log`). Workspace `pnpm build` completed commerce
  and its dependencies, then remaining downstream tasks were stopped with the
  coordinator's authorization to reduce memory contention (`build.log`). This is
  **not** a full-workspace build pass; the coordinator owns that integrated gate.
- `pnpm --filter @happyvertical/smrt-commerce test`: pass (`test.log`), 486 model,
  arithmetic and contract tests plus 144 UI tests. Seventeen environment-gated
  cases were skipped in this default invocation; the explicit PostgreSQL lane
  below exercises the optional suite.
- `pnpm --filter @happyvertical/smrt-commerce typecheck`: pass (`typecheck.log`),
  including Svelte diagnostics with zero errors and warnings.
- `pnpm --filter @happyvertical/smrt-commerce test:e2e`: pass (`browser.log`),
  parties and invoices 9 tests each, plus quote/pricing/purchasing native and
  hydrated proofs. Invoice coverage includes the built public cost-billing
  module executing signed cost/tax arithmetic directly in Chromium 152.
- `pnpm --filter @happyvertical/smrt-commerce test:postgres`: pass (`postgres.log`),
  48 tests / 4 files, using an isolated database via the documented runner.
- `pnpm lint`, `pnpm audit:policy`: pass (`lint.log`, `audit-policy.log`).

The new API uses no database, tenant context, network transport or mutable service
state; the pure tests and browser contract test exercise its complete runtime
boundary. Existing invoice calculation tests retain the prior signed tie rule.
- `pnpm --filter @happyvertical/smrt-commerce verify:pack`: pass
  (`verify-pack.log`), including new runtime and declaration exports.
- `pnpm knowledge:check --changed --strict --format markdown`: pass
  (`knowledge.log`), zero errors or warnings.
