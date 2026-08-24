# @happyvertical/smrt-marketing

Cross-channel Campaign models, immutable performance snapshots, computed
budget pacing, and reusable Svelte marketing surfaces for s-m-r-t.

```bash
pnpm add @happyvertical/smrt-marketing
```

```ts
import {
  BudgetPacingService,
  CampaignChannelCollection,
  CampaignCollection,
  MetricIngestionService,
} from '@happyvertical/smrt-marketing';

const campaigns = await CampaignCollection.create({ db });
const channels = await CampaignChannelCollection.create({ db });
const campaign = await campaigns.create({
  tenantId,
  customerId,
  campaignKey: 'summer-demand-2026',
  name: 'Summer demand 2026',
  objective: 'demand_generation',
  budgetCents: 200_000,
  currency: 'CAD',
});
if (!campaign.id) throw new Error('Campaign did not persist');

const adGroup = await channels.create({
  tenantId,
  campaignId: campaign.id,
  channelKind: 'ad_group',
  channelRef: 'ad-group-42',
  allocatedBudgetCents: 150_000,
});
if (!adGroup.id) throw new Error('Campaign channel did not persist');

const ingestion = await MetricIngestionService.create({ db });
await ingestion.ingest({
  tenantId,
  campaignId: campaign.id,
  campaignChannelId: adGroup.id,
  periodStart: new Date('2026-07-01T00:00:00Z'),
  periodEnd: new Date('2026-07-01T23:59:59Z'),
  spendCents: 12_500,
  impressions: 25_000,
  clicks: 800,
  conversions: 35,
  leads: 20,
  source: 'ad-platform',
  dedupeKey: `${tenantId}:summer-demand-2026:ad-group-42:2026-07-01`,
});

// Channel-scoped evidence is accepted only when the channel belongs to the
// supplied campaign. Reporting periods are required valid date-like values.

const pacing = await BudgetPacingService.create({ db });
console.log(await pacing.getCampaignPacing(campaign.id));
```

## Customer-scoped campaign reads

`Campaign.customerId` is the native UUID relationship to the canonical
`@happyvertical/smrt-commerce:Customer`. A campaign and its Customer must have
exactly the same tenant, and customer-scoped reads require that tenant
explicitly (`null` selects the global/global scope). Associated Campaign saves
validate and persist in one transaction; customer-scoped reads validate and
query in one transaction. Missing and cross-tenant Customers fail with
`CampaignCustomerScopeError` without disclosing which condition occurred.

```ts
const firstPage = await campaigns.listByCustomer(tenantId, customerId, {
  limit: 50,
});
const secondPage = firstPage.nextCursor
  ? await campaigns.listByCustomer(tenantId, customerId, {
      limit: 50,
      after: firstPage.nextCursor,
    })
  : null;

const summaries = await campaigns.summarizeByCustomers(tenantId, customerIds);
// [{ customerId, totalCount, activeCount, latestStartAt }]
```

Pages and summary batches are capped at 100 items and reject larger inputs.
Pagination is newest-first by `startAt`, then UUID; campaigns without a start
time follow scheduled campaigns. Summary resolution uses a bounded grouped
query rather than loading tenant campaigns or issuing one query per Customer.

### Migrating metadata-backed associations

1. Apply the generated schema migration that adds nullable native-UUID
   `campaigns.customer_id` and the
   `(tenant_id, customer_id, start_at, id)` index.
2. In an operator-owned data migration, extract the old metadata Customer id,
   validate that it exists in commerce and has the exact same `tenant_id`, then
   write `customer_id`. Stop on missing, malformed, or mismatched values.
3. Verify every expected association through `listByCustomer()` or
   `summarizeByCustomers()`, then update consumers to use these APIs.
4. Remove the old metadata key after verification. Marketing never reads it as
   a compatibility fallback, so there is no tenant-wide JSON or raw-SQL path to
   keep in sync.

Svelte components are exported from `@happyvertical/smrt-marketing/svelte`.
They are presentational and accept plain view models; consumers remain in
control of fetching and mutations.

See [AGENTS.md](./AGENTS.md) for lifecycle, evidence, and package-boundary
invariants.
