# Tenant-scoped subscription plans and flexible pricing (#3829)

Risk: high (tenant isolation, natural-key migration, monetary billing). This changes tenant-scoped persistence identities and monetary subscription terms. Amounts are integer minor units; the package contains no journalism-specific concepts.

| Behavior / invariant | Trigger | Positive | Negative / failure | Actor / context | Executor / transaction | Runtime / dialect | Contract edge | Level | Command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Plan key is tenant-scoped | Two worker co-ops create `membership` | Both records persist and resolve within their own tenant | Duplicate `(tenant, planKey)` remains one conflict identity | Tenant writer | Collection persistence | SQLite/PostgreSQL | Manifest conflict key | Integration | package test; `test:postgres` |
| Pricing is explicit and exact | Co-op defines free, fixed and pay-what-you-can tiers | Modes and minimum/suggested minor-unit amounts persist; subscriber agreed amount persists | Fractional/invalid monetary input is rejected | Tenant writer and external subscriber | Model validation and persistence | SQLite/PostgreSQL | Public model/options | Unit/integration | package test |
| Provider binding is optional | Offline worker co-op tier | Plan exists with no provider metadata | Legacy Stripe-only fields are not required for a plan | Tenant writer | Manifest persistence | SQLite/PostgreSQL | Provider-neutral API | Integration | package test |
| External entitlement remains scoped | External worker-member subscription resolves | Resolver loads the tenant's plan and grants its feature | A same key in another tenant cannot alter the result | External subscriber | Resolver reads | SQLite/PostgreSQL | Entitlement resolver | Integration | package test |

Tier amendment/renewal/cancellation continuity is deliberately covered by #4032; this foundation must not be represented as that acceptance.

## Review corrections and executable cases

- `subscription-plan-foundation.test.ts`: unknown pricing mode, nonzero free price, absent/below-minimum agreed amount, agreed amount on fixed plan, and update-path rejection. Existing scoped worker-co-op fixtures cover provider-less and external membership persistence.
- `plan-key-upgrade.optional.test.ts`: SQLite and restricted PostgreSQL reconstruct the pre-3829 table (including global unique key), preserve an existing record, apply the public core schema diff, run legacy cleanup twice, and prove scoped upsert plus global-null uniqueness. The SQL adapter is loaded directly so test auto-schema setup cannot mask migration gaps.
- Commerce `billing-period-close{,.optional}.test.ts`: tenant monthly free/PWYC invoices and close retry on SQLite/PostgreSQL. The agreed amount is 750 while suggested is 1500, proving consent controls the charge; free creates no invoice. Existing fixed-plan/provider-owned billing cases remain covered. External invoice routing is host-owned and unchanged.
- Regression: the new PWYC close test fails on prior head `058cdcfc` (no invoice) and passes with the correction. Payment provider contract is the existing fake provider; no remote charges occur.
- Atomicity: pricing validation precedes the single model save; period-close uses the existing claim/invoice transactions, exercised by its existing rollback/replay suite. This change adds no separate write transaction.

## Round 2 corrections

- Pricing references now use the public plan collection. Tenant-context reads and a bounded null-tenant global fallback reject missing/foreign plans; only explicit system context can bind seller plans to child tenants. SQLite/PostgreSQL upgrade tests exercise missing, foreign, global and trusted-system cases with tenancy enabled.
- Plan mode/minimum edits with existing subscribers fail before mutation. The same guard checks natural-key upsert targets. Full effective-dated transitions remain #4032.
- SQLite/PostgreSQL period-close regressions corrupt one legacy plan deliberately, assert its payer fails with the subscription ID while another payer completes, repair the subscriber's agreed amount, and retry without duplicate invoices.
- Review packet correction: `2889e7b` was not an ancestor of old head `d5b3d7e`; actual old merge-base was `0b2afabb`. The apparent collection-exposure deletion was an invalid two-dot packet base, not part of the PR three-dot diff. Branch rebased onto `f31c4a5601a92a420c44c88265752a7799fbd661`; current gate/build and affected runtime tests must pass on that tree. No gate is deleted by this change.

## Round 3 corrections

- Enabled-tenancy SQLite/PostgreSQL tests create both plans and subscriptions without explicit tenant IDs, verify context population, and reject explicit foreign tenant bindings.
- Pricing mode and minimum are immutable once persisted, including natural-key upserts. SQLite/PostgreSQL tests reject a stale free-to-fixed editor before and after signup and confirm the persisted free plan still has zero price. This avoids check-then-save subscriber-count races; full price/entitlement version snapshots remain #4032.

## Round 4 correction

- A coordinated SQLite/PostgreSQL natural-key race holds both first-create lookups before either insert. Exactly one write succeeds; the losing create cannot reprice the winner. Matching-term retries retain one identity; different mode/minimum remains rejected. Initial writes use core's existing strict-insert API, with no framework workaround or dependency on another unreleased branch.

## External review corrections

- Reader and supplied-context entitlement paths reject foreign-owned plans, accept own/global plans, and preserve explicit trusted system-context seller-to-child resolution (`subscription-resolver.test.ts`).
- SQLite/PostgreSQL upgrade fixtures prove legacy Stripe lookup fallback and reject that fallback for explicit other-provider bindings.
- PlanPicker SSR tests and browser QA verify free/PWYC minimum/suggestion labels while existing fixed-price/currency rendering remains covered.
