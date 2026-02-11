# @happyvertical/smrt-sites

Multi-tenant site management with agent bindings and infrastructure provisioning. Models sites as configurable deployable units with domain, tier, and agent configuration.

## Architecture

```
src/
  index.ts              # Export barrel
  types.ts              # SiteStatus, SiteTier, ProvisioningStatus, SitePortalConfig
  models/
    Site.ts             # Site model with domain, tier, provisioning
    SiteAgentBinding.ts # Junction linking sites to agents
  collections/
    SiteCollection.ts
    SiteAgentBindingCollection.ts
  services/
    SiteService.ts      # Site lifecycle management
```

## Key Models

- `Site` — domain, status, tier (free/standard/premium), databaseUrl, portalConfig, templateName, provisioningStatus
- `SiteAgentBinding` — Junction table: siteId + agentClass with per-site config overrides, priority, enabled flag

## Key Patterns

- **Status lifecycle**: draft → active → suspended → archived
- **Provisioning**: pending → provisioning → ready → failed
- **Agent bindings**: Sites can bind multiple agents with per-site configuration overrides
- **Portal config**: Theme, branding, navigation stored as JSON
- **Multi-tenancy**: Required tenant scoping on SiteAgentBinding, optional on Site
- **Custom conflict columns**: SiteAgentBinding uses `[site_id, agent_class]`

## Dependencies

- `@happyvertical/smrt-core`, `@happyvertical/smrt-tenancy`
- `@happyvertical/sql`, `@happyvertical/utils`
