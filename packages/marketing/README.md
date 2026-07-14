# @happyvertical/smrt-marketing

Cross-channel Campaign models, immutable performance snapshots, computed
budget pacing, and reusable Svelte marketing surfaces for SMRT.

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

const pacing = await BudgetPacingService.create({ db });
console.log(await pacing.getCampaignPacing(campaign.id));
```

Svelte components are exported from `@happyvertical/smrt-marketing/svelte`.
They are presentational and accept plain view models; consumers remain in
control of fetching and mutations.

See [AGENTS.md](./AGENTS.md) for lifecycle, evidence, and package-boundary
invariants.
