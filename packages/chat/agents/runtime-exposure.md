# Runtime cookbook exposure

See [the owning core contract](../../core/agents/runtime-exposure.md) for the
opt-in gate, trusted tenant selection, failure behavior, notification lifecycle
and AOT/startup limits. This package reuses that gate in its existing dispatcher;
it does not implement a second cookbook engine or operation execution path.

The manifest tool loop filters the offered catalog under `principal.tenantId`
and checks again before executing either the normal dispatcher or an injected
executor. `invokeManifestTool` independently rechecks using the principal run's
tenant. The AOT permission catalog remains intact for typo validation. Extra
tools, browser tools and external drivers remain host integrations and must
use core's gate when they expose model operations.
