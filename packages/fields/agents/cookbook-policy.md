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
