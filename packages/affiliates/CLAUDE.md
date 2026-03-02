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

## Gotchas

- **No tenancy** (intentional): cross-tenant network visibility for affiliate tracking
- **partnerTypes is JSON string**: must parse with `getPartnerTypes()` helper
- **Commission rate copied at event time**: immutable record, not a live reference to Partner.commissionRate
- **Payout amounts in cents**: divide by 100 for display
- **No ledger integration**: Payout → Invoice mapping is external
