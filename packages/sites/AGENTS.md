# @happyvertical/smrt-sites

Multi-tenant site lifecycle management with agent bindings.

## Models

- **Site**: `domain` (unique per tenant), `tier` (free/standard/premium), `portalConfig` JSON, database connection, `provisioningStatus`/`provisioningTimestamp`. Status: draft/active/suspended/archived.
- **SiteAgentBinding**: junction linking sites to agent classes. Per-site `config` overrides and `priority` ordering. `conflictColumns: ['site_id', 'agent_class']`.

- **DnsZone** (`dns_zones`, apex `name`), **Domain** (`domains`, `zoneId` FK + `hostname`), **ProjectDomain** (`project_domains`, `domainId` FK, `projectId` `@crossPackageRef('@happyvertical/smrt-projects:Project')`, `role`). Named `DnsZone` because smrt-properties already registers `Zone`. `DomainService`: `domainsByZone(tenantId, zoneId)`, `domainsByProject(tenantId, projectId, role?)`, `unassignedDomains(tenantId)`; `ProjectDomainCollection.assign(domain, projectId, role?, tenantId?)` is idempotent, takes the tenant from the domain, and rejects a mismatched `tenantId`. `Site.domain` stays a string.

## SiteService

Stateless lifecycle ops: `activate()`, `suspend()`, `archive()`. `bindAgent()` handles upsert (update config if exists, create if not).

## Gotchas

- **Required tenancy**: both models use `@TenantScoped({ mode: 'required' })` — must have tenant context
- **portalConfig accepts both object and JSON string** in constructor
- **SiteAgentBinding.config is nullable**: auto-parsed from JSON on init
- **Status tracking only; nothing is provisioned here**: `markProvisioned()` / `markProvisioningFailed()` record `provisioningStatus` for a host that does the real provisioning and deployment (infrastructure, credentials, content UI)
