---
'@happyvertical/smrt-agents': minor
'@happyvertical/smrt-scanner': minor
---

- Agents contribute "create" entries through their manifest: a static
  `createEntries` (id, type, format, label, description, icon, route relative
  to the host base path, order, availability) that the scanner captures;
  `resolveAgentCreateEntries()` (from `./ui`) filters, links and sorts them.
- `tenantAgentConfigOwnerId()` / `parseTenantAgentConfigOwnerId()`, and
  `repairTenantAgentConfigKeys(db, { aliases, apply })`, which moves
  `agent_configs` rows keyed by pre-#1092 `<tenant>:<Class>` ids (and stale
  `tenant_agents` bindings) to the canonical type: a counted dry run by
  default, one transaction on apply, refusing when any row is blocked.
- `data.query` states its request grammar in the tool schema and explains
  invalid requests; id (uuid) fields offer only `eq`/`ne`/`in`/`notIn` and
  reject non-uuid values before they reach PostgreSQL.
