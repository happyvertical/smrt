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

## Allowed field values (#4381)

A `string`, `number`, or `boolean` field may declare `values`: a closed set of
`{ value, label?, description? }` entries in declaration order, so an agent can
map "open" onto `status in [pending, in_progress]`. Values are host-declared
schema, never inferred from rows. `normalizeDataQuerySchema()` (via the
exported `normalizeDataQueryFieldValues()`) requires a non-empty, duplicate-free
list of at most `MAX_DATA_QUERY_FIELD_VALUES` (100) entries whose values match
the field type; value, label, and description text are bounded
(`MAX_DATA_QUERY_FIELD_VALUE_LENGTH` 256, `..._LABEL_LENGTH` 128,
`..._DESCRIPTION_LENGTH` 512) and reject Unicode control, format (bidi,
zero-width), surrogate, and line/paragraph-separator characters. Declared values
are enforced by default: non-null `eq`/`ne`/`in`/`notIn` filter values must be
members, or the request fails with `DATA_QUERY_VALUE_NOT_ALLOWED` and a message
listing the allowed values. The message and `details.allowedValues` both stop
at the first 20 values; `details.allowedValueCount` gives the full size.
`ne`/`notIn` are checked too: a misspelled value there would otherwise
silently match every row. `valuesEnforced: false` (valid only with `values`) marks the set advisory and
skips that check; the normalized schema keeps only the `false` form. Range and
`like` operators, result rows, and facets are never checked against the set.

Only normalized `DataQueryResult` envelopes cross REST, MCP, WebMCP, and browser
boundaries. Adapter-specific report/content context wraps the base envelope; it
does not add unsafe fields or SQL-like controls.
