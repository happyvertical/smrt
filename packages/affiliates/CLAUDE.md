# smrt-affiliates - Affiliate Partner & Commission Tracking

## Purpose

The `smrt-affiliates` package provides models for tracking revenue sharing with partners in an advertising network. It handles:

- **Partners**: Entities that earn commissions (publishers, salespeople, referrers)
- **Commissions**: Revenue attribution per ad event
- **Payouts**: Aggregated payment batches

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Ad Event Occurs                          │
│                   (from smrt-ads.AdEvent)                    │
└─────────────────────────────┬───────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                  Commission Attribution                      │
│   ┌─────────────┐ ┌─────────────┐ ┌─────────────┐           │
│   │   Display   │ │  Referral   │ │    Sales    │           │
│   │ Commission  │ │ Commission  │ │ Commission  │           │
│   │ → Publisher │ │ → Referrer  │ │→ Salesperson│           │
│   └─────────────┘ └─────────────┘ └──────┬──────┘           │
│                                          │                   │
│                                   ┌──────▼──────┐           │
│                                   │   Parent    │           │
│                                   │ Commission  │           │
│                                   │→ Publisher  │           │
│                                   └─────────────┘           │
└─────────────────────────────┬───────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Payout Aggregation                        │
│   Commissions grouped by partner, paid when threshold met    │
└─────────────────────────────────────────────────────────────┘
```

## Entity Relationships

```
Partner
├── profileId → smrt-profiles.Profile (identity)
├── propertyId → smrt-properties.Property (for publishers)
└── parentPartnerId → Partner (self-ref for site-attached salespeople)

Commission
├── eventId → smrt-ads.AdEvent (source event)
├── partnerId → Partner (earner)
└── payoutId → Payout (when included)

Payout
├── partnerId → Partner (recipient)
└── invoiceId → smrt-commerce.Invoice (payment record)
```

## Revenue Flow Example

```
Ad impression worth $0.01 CPM
├── Commission (display)  → Publisher            = $0.0050 (50%)
├── Commission (referral) → Referrer             = $0.0005 (5%)
├── Commission (sales)    → Salesperson          = $0.0008 (8% after parent)
├── Commission (parent)   → Salesperson's site   = $0.0002 (20% of sales)
└── Network Revenue       → Platform             = $0.0035 (35%)
```

## Key Concepts

### Partner Types

A partner can have multiple types:
- **Publisher**: Owns sites that display ads (earns display commissions)
- **Salesperson**: Brings in advertisers (earns sales commissions)
- **Referrer**: Refers new publishers (earns referral commissions)

### Commission Types

- **Display**: Publisher's share of impression revenue
- **Referral**: Referrer's share of referred partner's revenue
- **Sales**: Salesperson's share of advertiser spend
- **Parent**: Publisher's share when site-attached salesperson earns

### Parent Commission Share

Salespeople can be "attached" to a publisher (their `parentPartnerId`). When the salesperson earns a sales commission, a portion goes to the parent publisher:

```typescript
// Salesperson attached to publisher with 20% parent share
salesperson.parentPartnerId = publisher.id;
salesperson.parentCommissionShare = 0.20;

// On $100 ad spend:
// - Salesperson gets: $10 * 0.80 = $8 (sales commission minus parent share)
// - Publisher gets: $10 * 0.20 = $2 (parent commission)
```

### Currency Support

All monetary values stored in cents (integers) with a `currency` field:
- Default: `'CAD'`
- UI displays CAD only initially
- Database supports future multi-currency without schema changes

## Usage

### Creating a Publisher Partner

```typescript
import {
  PartnerCollection,
  Partner,
  PartnerType,
  PartnerStatus
} from '@happyvertical/smrt-affiliates';

const partners = new PartnerCollection(db);

const publisher = await partners.create({
  profileId: 'profile-uuid',
  propertyId: 'property-uuid',
  partnerTypes: JSON.stringify([PartnerType.PUBLISHER]),
  displayCommissionRate: 0.50,  // 50% of ad revenue
  payoutThreshold: 5000,        // $50 minimum payout
  status: PartnerStatus.ACTIVE
});
```

### Creating a Site-Attached Salesperson

```typescript
const salesperson = await partners.create({
  profileId: 'salesperson-profile-uuid',
  parentPartnerId: publisher.id,
  partnerTypes: JSON.stringify([PartnerType.SALESPERSON]),
  salesCommissionRate: 0.10,
  parentCommissionShare: 0.20,  // 20% goes to parent publisher
  status: PartnerStatus.ACTIVE
});
```

### Creating Commissions from Ad Events

```typescript
import {
  CommissionCollection,
  CommissionType,
  CommissionStatus
} from '@happyvertical/smrt-affiliates';

const commissions = new CommissionCollection(db);

// Display commission for publisher
await commissions.create({
  eventId: adEvent.id,
  partnerId: publisher.id,
  commissionType: CommissionType.DISPLAY,
  grossRevenue: 100,  // $0.01 in cents
  commissionRate: 0.50,
  commissionAmount: 50,  // $0.005
  currency: 'CAD',
  eventTimestamp: adEvent.timestamp,
  status: CommissionStatus.PENDING
});
```

### Creating a Payout

```typescript
import {
  PayoutCollection,
  PayoutStatus
} from '@happyvertical/smrt-affiliates';

const payouts = new PayoutCollection(db);

// Get pending earnings
const breakdown = await commissions.getPendingBreakdown(publisher.id);

if (breakdown.total >= publisher.payoutThreshold) {
  const payout = await payouts.create({
    partnerId: publisher.id,
    periodStart: new Date('2024-01-01'),
    periodEnd: new Date('2024-01-31'),
    displayEarnings: breakdown.display,
    referralEarnings: breakdown.referral,
    salesEarnings: breakdown.sales,
    parentEarnings: breakdown.parent,
    totalAmount: breakdown.total,
    currency: 'CAD',
    status: PayoutStatus.PENDING
  });

  // Mark commissions as included
  const pending = await commissions.findPendingByPartner(publisher.id);
  for (const c of pending) {
    await commissions.update(c.id, {
      payoutId: payout.id,
      status: CommissionStatus.INCLUDED
    });
  }
}
```

## Models Reference

### Partner

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| profileId | string | '' | FK to Profile |
| propertyId | string | '' | FK to Property (publishers only) |
| partnerTypes | string (JSON) | '[]' | Array of PartnerType |
| parentPartnerId | string | '' | Self-ref for site-attached partners |
| parentCommissionShare | number | 0 | Share to parent (0-1) |
| displayCommissionRate | number | 0.50 | Display commission rate |
| referralCommissionRate | number | 0.05 | Referral commission rate |
| salesCommissionRate | number | 0.10 | Sales commission rate |
| payoutThreshold | number | 5000 | Min payout in cents ($50) |
| payoutMethod | PayoutMethod | BANK_TRANSFER | Payment method |
| currency | string | 'CAD' | Currency code |
| status | PartnerStatus | PENDING | Account status |
| metadata | string (JSON) | '' | Additional data |

### Commission

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| eventId | string | '' | FK to AdEvent |
| partnerId | string | '' | FK to Partner |
| commissionType | CommissionType | DISPLAY | Type of commission |
| grossRevenue | number | 0 | Event revenue (cents) |
| commissionRate | number | 0 | Applied rate (0-1) |
| commissionAmount | number | 0 | Calculated amount (cents) |
| currency | string | 'CAD' | Currency code |
| payoutId | string | '' | FK to Payout (when included) |
| status | CommissionStatus | PENDING | Commission status |
| eventTimestamp | Date | now | Event time |
| metadata | string (JSON) | '' | Additional data |

### Payout

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| partnerId | string | '' | FK to Partner |
| periodStart | Date | now | Period start |
| periodEnd | Date | now | Period end |
| displayEarnings | number | 0 | Display earnings (cents) |
| referralEarnings | number | 0 | Referral earnings (cents) |
| salesEarnings | number | 0 | Sales earnings (cents) |
| parentEarnings | number | 0 | Parent earnings (cents) |
| totalAmount | number | 0 | Total (cents) |
| currency | string | 'CAD' | Currency code |
| invoiceId | string | '' | FK to Invoice |
| status | PayoutStatus | PENDING | Payout status |
| paymentReference | string | '' | Check/transfer ID |
| paidAt | Date | null | Payment date |
| notes | string | '' | Admin notes |
| metadata | string (JSON) | '' | Additional data |

## Collections

### PartnerCollection

| Method | Description |
|--------|-------------|
| `findByProfile(profileId)` | Partners for a profile |
| `findByProperty(propertyId)` | Partner for a property |
| `findByParent(parentPartnerId)` | Child partners |
| `findByStatus(status)` | Partners by status |
| `findActive()` | Active partners |
| `findPending()` | Pending approval |
| `findByType(type)` | Partners by type |
| `findPublishers()` | All publishers |
| `findSalespeople()` | All salespeople |
| `findActivePublishers()` | Active publishers |
| `findActiveByProperty(propertyId)` | Active publisher for property |

### CommissionCollection

| Method | Description |
|--------|-------------|
| `findByPartner(partnerId)` | Commissions for partner |
| `findByEvent(eventId)` | Commissions for event |
| `findByPayout(payoutId)` | Commissions in payout |
| `findPending()` | All pending commissions |
| `findPendingByPartner(partnerId)` | Pending for partner |
| `findByType(type)` | By commission type |
| `findByDateRange(start, end)` | In date range |
| `sumPendingByPartner(partnerId)` | Sum pending cents |
| `getEarningsBreakdown(partnerId)` | Breakdown by type |
| `getPendingBreakdown(partnerId)` | Pending breakdown |

### PayoutCollection

| Method | Description |
|--------|-------------|
| `findByPartner(partnerId)` | Payouts for partner |
| `findByStatus(status)` | Payouts by status |
| `findPending()` | Awaiting approval |
| `findApproved()` | Ready for processing |
| `findCompleted()` | Completed payouts |
| `findByInvoice(invoiceId)` | By invoice |
| `sumPaidByPartner(partnerId)` | Total paid |
| `sumPendingByPartner(partnerId)` | Total pending |
| `findLatestByPartner(partnerId)` | Most recent payout |
| `getStats()` | Overall statistics |

## Enums

### PartnerType
- `PUBLISHER` - Site owner
- `SALESPERSON` - Advertiser rep
- `REFERRER` - Partner referrer

### PartnerStatus
- `PENDING` - Awaiting approval
- `ACTIVE` - Can earn
- `SUSPENDED` - Earnings paused

### CommissionType
- `DISPLAY` - Impression revenue
- `REFERRAL` - Referral revenue
- `SALES` - Advertiser revenue
- `PARENT` - Parent share

### CommissionStatus
- `PENDING` - Not in payout
- `INCLUDED` - In pending payout
- `PAID` - Payout completed

### PayoutStatus
- `PENDING` - Awaiting approval
- `APPROVED` - Ready for processing
- `PROCESSING` - Payment in progress
- `COMPLETED` - Payment done
- `FAILED` - Payment failed

### PayoutMethod
- `BANK_TRANSFER`
- `CHECK`
- `PAYPAL`
- `CREDIT`

## Testing

```bash
# Generate test manifest
pnpm run generate:test

# Run tests
pnpm test

# Watch mode
pnpm test:watch
```

## Dependencies

**Required:**
- `@happyvertical/smrt-core` - Base framework

**Peer (optional):**
- `@happyvertical/smrt-ads` - Ad event source
- `@happyvertical/smrt-commerce` - Invoice integration
- `@happyvertical/smrt-profiles` - Partner identity
- `@happyvertical/smrt-properties` - Publisher sites
