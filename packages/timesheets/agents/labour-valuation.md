# Exact percentage labour and analytical reconciliation

Tracking: SMRT #3813; consumer tradeschief.com #283. Existing additive
`DatedLabourCommercialResolver` inputs and `dated-labour-v1` snapshots are
unchanged. No schema, dependency or migration changes.

`DatedPercentageLabourCommercialResolver` accepts the same dated host-authorized
schedule context, with `burdenPercent: { id, version, percent }` replacing
`burden`. Percent uses percentage points (`20` means twenty percent), not hourly
minor units or fractional `0.20`. Wage/customer rates and percent inputs support
up to 18 fractional digits of nonnegative plain decimal text. Each decimal
input is bounded to 40 characters and a value no greater than
`Number.MAX_SAFE_INTEGER`; these input/resource limits do not limit derived
product precision. Final components and aggregate amounts must be safe integer
minor units. Derived
hourly burden remains an exact rational, including products beyond 18 places;
no intermediate rounding or re-parsing through the hourly-rate precision limit.
Only final component amounts round half up. Provider amount is wage; private
terms retain loaded cost, percentage identity/version and exact hourly basis.
The compensation version is `dated-percentage-labour-v1`. Client terms retain
the original public allowlist and do not reveal the chosen compensation mode.

The host selects immutable tenant/project policies, currency, input precision,
and approved wage/percentage versions, and authorizes the worker. Supply the
same retained input for an incomplete approval retry. Later configuration cannot
reconstruct or amend a pending snapshot. Only supported modes may be offered;
missing required policy is a host validation error, never a migration default.

`reconcileLabourValuation` is a pure private report calculation, not a posting
API. Explicit mode `half-up-exact-loaded-aggregate` sums exact hours times wage
plus exact hours times burden across supplied approved snapshots, then rounds
that combined aggregate once. `canonicalCostMinor` separately sums the original
independently rounded component amounts. `differenceMinor` is analytical minus
canonical. Regrouping may change analytical rounding, never the canonical facts.

The caller supplies explicit tenant/currency/group id and revision, plus 1–10000
private evidence records. Each binds entry/snapshot/worker identity, host policy
id/version/digest, and a frozen compensation snapshot (including its native
id, tenantId and timeEntryId). Map native `termsVersion`/`rateSnapshot` to
`version`/parsed `terms` at the host boundary. Missing or unsupported calculation
terms, mixed currencies/tenants/groups, duplicate entries/snapshots, conflicting
policy digests/rate revisions, altered retained arithmetic and unsafe amounts
are rejected. Negative/reversal evidence is unsupported; a signed difference is
allowed. Input order does not affect results or sorted evidence membership.

IDs, group membership and supplied policy digests are consistency checks, not
proof of authenticity or authorization. The host loads authorized immutable
snapshots, verifies worker ownership and excludes superseded/corrected entries.
The API cannot discover omitted evidence or authenticate an invented snapshot.
It has no database, policy lookup, financial mutation or public projection.

## Behavior-to-test matrix

All rows below require current executable evidence before review and publication.
Package unit command: `pnpm --filter @happyvertical/smrt-timesheets test`.
Native command: `pnpm --filter @happyvertical/smrt-timesheets test:postgres`.

| Behavior/invariant | Reachable trigger; positive / negative | Actor/context | Executor/transaction | Runtime/dialect | External edge | Level / validation |
|---|---|---|---|---|---|---|
| Exact percentage components | Approval: quarter hours, zero, >18-place product / malformed, ambiguous, overflow | Authorized host worker | Pure preflight | Node; dialect N/A (pure) | Distinct percent vs amount | Public unit / package unit |
| Dated selection and isolation | Construct/approve: adjacent period / date gap, foreign tenant/worker | Host tenant × worker | Pure preflight | Node; dialect N/A (pure) | Existing dated API preserved | Public unit / package unit |
| Private immutable provenance | Partial approval then retry: retained terms / caller amendment | Owner vs client projection | Existing ServiceEvidenceService executor | SQLite + PostgreSQL | Opt-in version; old additive regression | Shared integration / package unit + native |
| Atomic host mutation | Approved entry then exception / zero persisted effects | Tenant host | All collections bind host transaction | SQLite + PostgreSQL | Database rollback | Shared integration / package unit + native |
| Canonical vs analytical | Two fractional entries: sum rounded vs rounded sum / invalid amount, unsupported version/mode | Authorized private reader | N/A pure, no writes | Node; dialect N/A (pure) | Frozen snapshot input | Public unit / package unit |
| Evidence integrity | Reordering/grouping: stable canonical and permutation / duplicates, foreign identity, drift | Tenant + group + supplied policy | N/A pure, no writes | Node; dialect N/A (pure) | Host authenticates inputs | Public unit / package unit |
| Release compatibility | Package import/build: exported types/resolvers / inaccessible exports | Public consumer | N/A no persistence | Supported package runtime | Published artifact | Build/typecheck/verify:pack plus coordinator public consumer proof |

This is an additive feature, not a claimed regression fix; base-failure comparison
is N/A. Existing additive assertions remain unchanged. Run package
build/typecheck, downstream projects/support tests and applicable documented root
checks before exact-head review. Two independent financial/public-contract
reviews are required before shipping. Exact-head results belong in the pull
request and its validation/review evidence, not this durable contract.
