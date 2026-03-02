# @happyvertical/smrt-sites

Site lifecycle management for multi-tenant SMRT networks. Manages sites with provisioning status, tier classification, portal configuration, and agent bindings with priority ordering.

## Installation

```bash
pnpm add @happyvertical/smrt-sites
```

## Usage

```typescript
import {
  Site, SiteCollection,
  SiteAgentBinding, SiteAgentBindingCollection,
  SiteService
} from '@happyvertical/smrt-sites';

// Create a site
const sites = new SiteCollection(db);
const site = await sites.create({
  name: 'Community Hub',
  domain: 'hub.example.com',
  status: 'active',
  tier: 'standard',
});
await site.save();

// Bind an agent to the site
const bindings = new SiteAgentBindingCollection(db);
await bindings.create({
  siteId: site.id,
  agentId: 'agent-news',
  priority: 1,
});

// Use the service for higher-level operations
const service = new SiteService({ db });
await service.provision({ name: 'New Site', domain: 'new.example.com' });
```

## API

### Models

| Export | Description |
|--------|------------|
| `Site` | Site record with domain, status, tier, and portal config |
| `SiteAgentBinding` | Associates an agent with a site at a given priority |

### Collections

`SiteCollection`, `SiteAgentBindingCollection`

### Services

| Export | Description |
|--------|------------|
| `SiteService` | High-level site provisioning and management |

### Key Types

`SiteOptions`, `SiteStatus`, `SiteTier`, `ProvisioningStatus`, `SitePortalConfig`, `SiteServiceOptions`, `SiteAgentBindingOptions`, `CreateSiteData`

## Dependencies

- `@happyvertical/smrt-core` — ORM and code generation
- `@happyvertical/smrt-tenancy` — multi-tenant scoping
- Peer: `@happyvertical/smrt-agents`
