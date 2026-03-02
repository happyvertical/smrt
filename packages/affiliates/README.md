# @happyvertical/smrt-affiliates

Affiliate partner and commission tracking models for the SMRT framework. Manages multi-type partners, multi-tier commissions, and payout processing.

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
  PartnerType, CommissionType
} from '@happyvertical/smrt-affiliates';

// Register a partner
const partners = new PartnerCollection(db);
const partner = await partners.create({
  name: 'Affiliate Blog',
  type: PartnerType.Affiliate,
  status: 'active',
});
await partner.save();

// Record a commission
const commissions = new CommissionCollection(db);
const commission = await commissions.create({
  partnerId: partner.id,
  type: CommissionType.Sale,
  amount: 15.50,
  status: 'pending',
});
await commission.save();
```

## API

### Models

| Export | Description |
|--------|------------|
| `Partner` | Affiliate partner with type, status, and contact info |
| `Commission` | Revenue share record with amount, type, and status |
| `Payout` | Payout batch for disbursing earned commissions |

### Collections

`PartnerCollection`, `CommissionCollection`, `PayoutCollection`

### Enums

| Export | Description |
|--------|------------|
| `PartnerType` | Partner classification |
| `PartnerStatus` | Partner lifecycle status |
| `CommissionType` | Type of commission earned |
| `CommissionStatus` | Commission lifecycle status |
| `PayoutMethod` | Disbursement method |
| `PayoutStatus` | Payout lifecycle status |

## Dependencies

- `@happyvertical/smrt-core` — ORM and code generation
- Peer: `@happyvertical/smrt-ads`, `@happyvertical/smrt-commerce`, `@happyvertical/smrt-profiles`, `@happyvertical/smrt-properties`
