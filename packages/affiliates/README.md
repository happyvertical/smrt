# @happyvertical/smrt-affiliates

Affiliate partner and commission tracking models for the SMRT framework. Manages multi-type partners (publisher/salesperson/referrer), multi-tier commission attribution, and payout batch processing.

## Installation

```bash
pnpm add @happyvertical/smrt-affiliates
```

## Usage

```typescript
import {
  Partner, PartnerCollection,
  Commission, CommissionCollection,
  Payout, PayoutCollection,
  PartnerType, CommissionType, CommissionStatus, PayoutStatus
} from '@happyvertical/smrt-affiliates';

// Register a publisher partner (earns display commissions)
const partners = new PartnerCollection(db);
const publisher = await partners.create({
  profileId: 'profile-uuid',
  propertyId: 'property-uuid',
  partnerTypes: JSON.stringify([PartnerType.PUBLISHER]),
  displayCommissionRate: 0.50,
  status: 'active',
});

// Attach a salesperson to the publisher
// parentCommissionShare: 20% of sales commission goes to parent publisher
const salesperson = await partners.create({
  profileId: 'sales-profile-uuid',
  parentPartnerId: publisher.id,
  partnerTypes: JSON.stringify([PartnerType.SALESPERSON]),
  salesCommissionRate: 0.10,
  parentCommissionShare: 0.20,
  status: 'active',
});
// Effective sales rate: 0.10 * (1 - 0.20) = 0.08
salesperson.getEffectiveSalesRate(); // 0.08

// Record a commission (all monetary values in integer cents)
const commissions = new CommissionCollection(db);
await commissions.create({
  eventId: 'adevent-uuid',
  partnerId: publisher.id,
  commissionType: CommissionType.DISPLAY,
  grossRevenue: 1000,       // $10.00
  commissionRate: 0.50,
  commissionAmount: Commission.calculateAmount(1000, 0.50), // 500 cents
  currency: 'CAD',
  status: CommissionStatus.PENDING,
});

// Create a payout batch for the publisher
const payouts = new PayoutCollection(db);
const payout = await payouts.create({
  partnerId: publisher.id,
  periodStart: new Date('2024-01-01'),
  periodEnd: new Date('2024-01-31'),
  displayEarnings: 25000,   // $250.00
  referralEarnings: 500,    // $5.00
  salesEarnings: 0,
  parentEarnings: 0,
  totalAmount: 25500,       // $255.00
  currency: 'CAD',
  status: PayoutStatus.PENDING,
});

// Payout lifecycle: PENDING -> APPROVED -> PROCESSING -> COMPLETED (or FAILED)
payout.approve();
payout.markProcessing();
payout.complete('transfer-ref-123');
await payout.save();
```

### Commission Types

Each ad event can generate up to four commissions:

| Type | Recipient | Description |
|------|-----------|-------------|
| `DISPLAY` | Publisher | Site owner earns share of impression revenue |
| `REFERRAL` | Referrer | Partner who referred the publisher |
| `SALES` | Salesperson | Partner who brought in the advertiser |
| `PARENT` | Parent publisher | Share of salesperson's commission |

## API

### Models

| Export | Description |
|--------|------------|
| `Partner` | Affiliate partner with multi-type roles, commission rates, payout threshold, and parent hierarchy |
| `Commission` | Immutable revenue attribution record (no delete). `calculateAmount(grossRevenue, rate)` static helper |
| `Payout` | Aggregated payment batch with status lifecycle and per-type earnings breakdown |

### Collections

`PartnerCollection`, `CommissionCollection`, `PayoutCollection`

### Enums

| Export | Values |
|--------|--------|
| `PartnerType` | `publisher`, `salesperson`, `referrer` |
| `PartnerStatus` | `pending`, `active`, `suspended` |
| `CommissionType` | `display`, `referral`, `sales`, `parent` |
| `CommissionStatus` | `pending`, `included`, `paid` |
| `PayoutStatus` | `pending`, `approved`, `processing`, `completed`, `failed` |
| `PayoutMethod` | `bank_transfer`, `check`, `paypal`, `credit` |

## Dependencies

- `@happyvertical/smrt-core` -- ORM and code generation
- Peer: `@happyvertical/smrt-ads`, `@happyvertical/smrt-commerce`, `@happyvertical/smrt-profiles`, `@happyvertical/smrt-properties`
