# Runtime cookbook exposure

See [the owning core contract](../../core/agents/runtime-exposure.md) for the
opt-in gate, trusted tenant selection, failure behavior, notification lifecycle
and AOT/startup limits. This package reuses that gate in its existing dispatcher;
it does not implement a second cookbook engine or operation execution path.

`CLIContext.tenantId` is host-owned. The lazy cache retains all generated
commands; each retrieval filters it by model membership. Generated command
handlers also recheck before running, so a retained handler cannot bypass a
later disable. Utilities and schema-management commands keep their existing
operator behavior. No tenant is inferred from user-supplied arguments.
