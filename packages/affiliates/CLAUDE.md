# @happyvertical/smrt-affiliates

Partner revenue sharing with multi-type partners, multi-tier commissions, and payout processing.

## Models

- **Partner**: `partnerTypes` JSON array (publisher/salesperson/referrer — multi-role). `parentPartnerId` for site-attached salespeople. `referredById` for referral attribution. `commissionRate`, `parentCommissionShare`.
- **Commission**: 4 types per ad event — Display (publisher), Referral (referrer), Sales (salesperson), Parent (parent publisher's share). **Immutable** — no update/delete API.
- **Payout**: batch aggregation. Status: `PENDING → APPROVED → PROCESSING → COMPLETED` (or FAILED).

## Currency

**All monetary fields are integer cents.** Helpers: `getTotalInDollars()`, `getAmountInDollars()`. `Commission.calculateAmount(grossRevenue, rate)` uses `Math.round()`.

## Parent Commission Share

```
Salesperson.parentCommissionShare = 0.20 (20% to parent publisher)
Effective sales rate = salesRate × (1 - parentCommissionShare)
```

## Cross-Package References (plain strings)

`profileId` → smrt-profiles, `propertyId` → smrt-properties, `eventId` → smrt-ads, `invoiceId` → smrt-commerce

## Tenancy

Per `docs/content/standards.md §7`, tenant-aware models normally apply
`@TenantScoped({ mode: 'optional' })` from `@happyvertical/smrt-tenancy`. The
three models in this package deviate intentionally; each `@smrt(...)` block
carries an inline comment pointing back to this section.

`Partner`, `Commission`, and `Payout` are deliberately **NOT** tenant-scoped.
The affiliate network is a cross-tenant graph by design:

- A single `Partner` (e.g. a publisher operating multiple sites across
  different tenants) needs a stable identity for revenue aggregation,
  payout thresholds, and tax reporting. Slicing partner identity per
  tenant would either duplicate the row or hide payouts owed across
  tenants.
- `Commission` rows attribute revenue to a partner across whichever tenant
  generated the ad event; the cross-tenant attribution is the point of the
  network.
- `Payout` aggregates commissions for a partner regardless of which tenant
  the underlying revenue came from. A tenant-scoped query would produce
  systematically incorrect totals.

This is the same reasoning that keeps `TenantKey` in `packages/secrets`
out of the tenancy interceptor: rows that must be queried across tenants
to fulfil their purpose should not be silently filtered.

Operators that need tenant-attributed reporting should aggregate by
joining `Commission` rows back to `eventId` (smrt-ads) and the originating
ad's tenant — not by adding `@TenantScoped` here.

## Gotchas

- **No tenancy** (intentional): cross-tenant network visibility for affiliate tracking — see Tenancy section above for rationale
- **partnerTypes is JSON string**: must parse with `getPartnerTypes()` helper
- **Commission rate copied at event time**: immutable record, not a live reference to Partner.commissionRate
- **Payout amounts in cents**: divide by 100 for display
- **No ledger integration**: Payout → Invoice mapping is external
