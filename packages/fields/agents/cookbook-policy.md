# Portable cookbook policy resolution

`resolveFieldPolicy(objectRef, { cookbook, ...context })` inserts the active
cookbook rows after stored app rows and before tenant/user tiers, using the same
`resolveFieldPolicyLayers` kernel as `./policy`. It bypasses both cache reads and
writes so switching cookbook documents never leaks a prior document's policy.
Database authorization, surviving tenant-chain selection, org locks and the
required-field safety net remain unchanged. Portable defaults use the existing
field-type/security validation; invalid encoded JSON contributes no override.
The browser boundary omits restricted/system metadata; the trusted server
resolver still includes sensitive fields for its existing batch projection to
filter. `readOnly` is portable record-value metadata, not a new database column
and not the existing `locked` policy-customization flag.

The `./policy` browser-safe entry extracts existing seed/merge helpers. It imports
neither the registry, database, tenancy nor model runtime. Client components must
never import the server resolver/root. `resolveCookbookFieldPolicy` accepts generated
public fields and optional manifest-proven `replacedQualifiedNames`.

`cookbookPolicyLayers` selects raw rows by canonical identity and proven provider
aliases, preserving sparse contributions. Provider rows apply in document order,
then effective app rows, so an app label cannot erase the provider's hidden/default
metadata. Unrelated same-name models never match. The server uses the live registry's
same replacement provenance and the same layer selector; stored policy scope and
authorization remain at their original boundary.

## Read-only linked display labels

`getObjectFieldMap` keeps the registry's persisted fields unchanged and adds the
virtual `displayLabel` only for a declared, validated one-hop projection. It reuses
`resolveDisplayLabelProjection`, public relationship/effective target resolution,
`displayLabelFieldProblem` and the existing security metadata helpers. No collection
is instantiated and no SQL runs to enumerate policy fields. Actual reads retain the
collection's stricter row/tenant/STI authorization and scoped SQL projection.

The synthetic field matches generated web metadata: text, basic, static `readonly`.
Its label/visibility may be customized by stored or raw cookbook rows. Static
read-only metadata is a code-seed contribution and cannot be cleared by a row;
policy defaults are rejected at write and resolution boundaries. Registry field maps
and application schema never acquire a persisted name column.

The resolver's real Commerce Customer -> Profile canary uses SQLite, actual
collections, public runtime registry metadata, the existing web-definition emitter,
stored policies and raw cookbook rows. The existing `manifestEntry` test fixture
adapts runtime metadata; this test does not depend on an unrelated Commerce build. It checks Profile names,
server/browser policy parity, relabel/hide selection, immutable read-only/default
rails, and rejection when the effective target becomes sensitive. No Commerce source
or helper is copied into Fields.
