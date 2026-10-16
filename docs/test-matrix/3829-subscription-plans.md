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
