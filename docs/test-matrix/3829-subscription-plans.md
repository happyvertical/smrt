# Tenant-scoped subscription plans and flexible pricing (#3829)

Risk: standard. This changes tenant-scoped persistence identities and monetary subscription terms. Amounts are integer minor units; the package contains no journalism-specific concepts.

| Behavior / invariant | Trigger | Positive | Negative / failure | Actor / context | Executor / transaction | Runtime / dialect | Contract edge | Level | Command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Plan key is tenant-scoped | Two worker co-ops create `membership` | Both records persist and resolve within their own tenant | Duplicate `(tenant, planKey)` remains one conflict identity | Tenant writer | Collection persistence | SQLite/PostgreSQL | Manifest conflict key | Integration | package test; `test:postgres` |
| Pricing is explicit and exact | Co-op defines free, fixed and pay-what-you-can tiers | Modes and minimum/suggested minor-unit amounts persist; subscriber agreed amount persists | Fractional/invalid monetary input is rejected | Tenant writer and external subscriber | Model validation and persistence | SQLite/PostgreSQL | Public model/options | Unit/integration | package test |
| Provider binding is optional | Offline worker co-op tier | Plan exists with no provider metadata | Legacy Stripe-only fields are not required for a plan | Tenant writer | Manifest persistence | SQLite/PostgreSQL | Provider-neutral API | Integration | package test |
| External entitlement remains scoped | External worker-member subscription resolves | Resolver loads the tenant's plan and grants its feature | A same key in another tenant cannot alter the result | External subscriber | Resolver reads | SQLite/PostgreSQL | Entitlement resolver | Integration | package test |

Tier amendment/renewal/cancellation continuity is deliberately covered by #4032; this foundation must not be represented as that acceptance.
