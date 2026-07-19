# @happyvertical/smrt-assets-ergot

Ergot-backed processing, search, synchronization, and workflow capabilities for
the s-m-r-t asset runtime. Applications continue to use
[`@happyvertical/smrt-assets`](../assets/README.md) as their asset API and opt
into Ergot only at composition time.

Use this adapter when an application needs MAM-backed search, generated media
candidates, cloud processors, workflow jobs, or synchronization with an Ergot
library. Use [`smrt-assets-local`](../assets-local/README.md) for lightweight
local image processing.

## Installation

```bash
pnpm add @happyvertical/smrt-assets @happyvertical/smrt-assets-ergot
```

The adapter is structurally typed around a small consumer client. It does not
force every s-m-r-t application to install an Ergot SDK.

## Quick start

```ts
import { createAssetRuntime } from '@happyvertical/smrt-assets';
import {
  createErgotAssetProcessor,
  type ErgotConsumerAssetClient,
} from '@happyvertical/smrt-assets-ergot';

const ergot: ErgotConsumerAssetClient = createErgotClient();
const runtime = await createAssetRuntime({
  db: 'assets.db',
  storage: './data/assets',
  capabilityProviders: [createErgotAssetProcessor({ client: ergot })],
});

const asset = await runtime.storeSourceAsset(
  'Lead image',
  imageBytes,
  { mimeType: 'image/jpeg', typeSlug: 'image' },
);

const synced = await runtime.syncExternalAsset(asset);
console.log(synced.externalAssetId);
```

Synchronization uses stable source references and external IDs. A s-m-r-t asset
ID and an Ergot asset ID are separate identities and must never be treated as
interchangeable.

## Capabilities

| Asset runtime operation | Ergot behavior |
| --- | --- |
| `syncExternalAsset()` | Idempotently find or upload by source reference |
| `searchNearbyAssets()` | Query Ergot's tenant-scoped nearby search |
| `ensureVariant()` | Resolve Ergot delivery variants when available |
| `submitAssetWorkflow()` | Submit a workflow job with source lineage |
| `processAsset()` | Delegate supported processing to Ergot |

Every request that can expose tenant data must carry tenant scope. Direct asset
and job lookups are validated even when the upstream client already scopes list
operations.

## Source references and outputs

- `sourceRef` is the canonical idempotent synchronization key.
- `externalId` is used when the consumer already owns a stable upstream key.
- Generated candidates remain candidates until approved and materialized into
  the s-m-r-t asset runtime.
- Variant metadata may reference Ergot delivery URLs without copying bytes.
- Workflow outputs preserve lineage to both the source asset and Ergot job.

## Public API

| Export | Purpose |
| --- | --- |
| `createErgotAssetProcessor()` | Create the s-m-r-t capability provider |
| `ErgotConsumerAssetClient` | Minimal client contract a host implements |
| `ErgotAssetSummary` | Provider-neutral view of an Ergot asset |
| `ErgotAssetProcessorOptions` | Client and source-system configuration |

## Development

```bash
pnpm --filter @happyvertical/smrt-assets-ergot test
pnpm --filter @happyvertical/smrt-assets-ergot typecheck
pnpm --filter @happyvertical/smrt-assets-ergot build
```

See [`AGENTS.md`](./AGENTS.md) for provider, tenancy, and lineage invariants.
