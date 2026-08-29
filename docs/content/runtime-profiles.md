---
title: Application runtime profiles
---

# Application runtime profiles

An s-m-r-t application declares one infrastructure profile and keeps the same
domain objects, workflows, generated interfaces, and approval policy when it
moves between a laptop and a deployment.

```ts
import { defineConfig } from '@happyvertical/smrt-config';

export default defineConfig({
  runtime: { profile: 'local' },
});
```

At startup, pass `config.runtime` to `resolveApplicationRuntime()`. The resolver
returns a deterministic, immutable, machine-readable snapshot for startup,
`doctor`, tests, and agent inspection. It reads no environment variables and
contains no connection strings, paths, credentials, or secret values.

## Safe presets

| Profile | Default composition | Supported choices |
| --- | --- | --- |
| `local` | user-owned SQLite; single-use owner bootstrap; real default tenant; local assets and secrets; embedded jobs; loopback binding; file-snapshot backup | jobs may run `inline`; TLS may be enabled while the bind remains loopback |
| `self-hosted` | operator PostgreSQL; OIDC; single tenant; S3-compatible assets; environment secrets; external workers; public TLS; operator backup | magic link auth; explicit multi-tenant mode with required context; local or S3-compatible assets; environment, local-file, or external secrets; application isolation or RLS |
| `cloud` | managed PostgreSQL; hosted identity; required multi-tenant context with RLS; managed storage and secrets; scalable workers; public TLS; managed backup | S3-compatible storage, external secret provider, or application-enforced isolation |

All three presets advertise logical export and import. Provider-specific
settings such as database URLs, asset roots, OIDC credentials, and secret
manager identifiers remain in the owning provider's configuration. The runtime
snapshot intentionally reports only safe selectors and derived capabilities.

## Explicit overrides

Profiles are presets, not environment-name conditionals. Apply supported
provider changes in one place:

```ts
export default defineConfig({
  runtime: {
    profile: 'self-hosted',
    providers: {
      authentication: { provider: 'magic-link' },
      tenancy: { mode: 'multi-tenant', context: 'required' },
      assets: { provider: 'local-files' },
    },
  },
});
```

The resolver reports effective changes under `diagnostics.overrides`. Unknown
fields and incompatible combinations fail before application startup with a
path, reason, and recovery action. For example, local owner bootstrap cannot be
combined with a public bind, and cloud mode cannot disable required tenant
context or TLS.

## Cross-profile invariants

Provider selection cannot change these application behaviors:

- domain models and workflows;
- generated REST and CLI surfaces;
- generated MCP and WebMCP definitions;
- action-effect metadata and human approval policy;
- real authorization records;
- the job invocation API;
- logical export/import portability.

The resolved snapshot includes these invariants so integration tests can compare
profiles directly. Implementing packages consume the contract; templates should
never copy profile conditionals into application code.
