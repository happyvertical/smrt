<!-- Module doc for packages/core/AGENTS.md. Linked from the Modules table there. -->

# Bounded data queries (#2444)

`normalizeDataQueryRequest()` and `normalizeDataQueryResult()` define the trust
boundary for the transport-neutral table/report/content query envelope. A
trusted adapter supplies `DataQuerySchema`; callers receive only its declared
projectable, sortable, filterable, and facetable fields. The helpers validate
and normalize but never execute SQL or decide tenant/principal access.

Use `createDataQueryFingerprint()` for cache and result correlation. It omits
request id and page position, canonicalizes equivalent filter/projection/facet
forms, and adds the identity sort tie-break. Keep values scalar and request,
page, and facet sizes positive and bounded. Results must stay within the schema
byte cap with declared field types preserved; datetimes are RFC 3339 instants,
identity fields are string/number/datetime-compatible, and JSON values are
bounded by depth, container count, string size, and bytes before cloning.

Only normalized `DataQueryResult` envelopes cross REST, MCP, WebMCP, and browser
boundaries. Adapter-specific report/content context wraps the base envelope; it
does not add unsafe fields or SQL-like controls.
