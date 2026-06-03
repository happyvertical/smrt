# @happyvertical/smrt-sites

Multi-tenant site lifecycle management with agent bindings.

## Models

- **Site**: `domain` (unique per tenant), `tier` (free/standard/premium), `portalConfig` JSON, database connection, `provisioningStatus`/`provisioningTimestamp`. Status: draft/active/suspended/archived.
- **SiteAgentBinding**: junction linking sites to agent classes. Per-site `config` overrides and `priority` ordering. `conflictColumns: ['site_id', 'agent_class']`.

## SiteService

Stateless lifecycle ops: `activate()`, `suspend()`, `archive()`. `bindAgent()` handles upsert (update config if exists, create if not).

## Gotchas

- **Required tenancy**: both models use `@TenantScoped({ mode: 'required' })` — must have tenant context
- **portalConfig accepts both object and JSON string** in constructor
- **SiteAgentBinding.config is nullable**: auto-parsed from JSON on init
