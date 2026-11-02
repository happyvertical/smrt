# Data-surface discovery metadata

Module reference for `packages/agents/AGENTS.md`.

## Allowed field values (#4381)

Declared field `values` (#4381; contract in core
[data-query.md](../../core/agents/data-query.md)) appear on `data.inspect` and
`data.discover` field descriptors with an explicit `valuesEnforced` flag; for
an enforced set an undeclared `eq`/`ne`/`in`/`notIn` value fails as a
`DataSurfaceRequestError` (`reason` `DATA_QUERY_VALUE_NOT_ALLOWED`) naming the
allowed values. Enum-derived smrt-collection values are advisory unless the
host sets `enforceDerivedValues`.

## Summary discovery and row-count hints (#4329)

`discoverDetail: 'summary'` (#4329; default `'full'`) makes `data.discover`
return only `id` (repeated as `surfaceId`, the argument name `data.inspect`
and `data.query` take, #4507), a cleaned `label`, the description's first non-empty line
bounded to 160 chars, and `rowCountHint`, with a discover tool description
pointing to `data.inspect`. Without a `rowCountHint`, full discovery and
`data.inspect` are byte-identical to before; a valid hint is added to both.
The catalog/RBAC gates, including identity-field denial, run the same in both
modes; query is unaffected. Summary mode assumes the persona may call
`data.inspect`: a host granting discover and query without inspect keeps full.
`DataSurfaceDefinition.rowCountHint` is host-supplied and never queried:
`normalizeDataSurfaceRowCountHint()` accepts a non-negative safe integer or a
trimmed label of at most 32 chars with something visible and no Cc/Cf/Zl/Zp
characters, and omits anything else. Every reader of the surface sees the
same hint, so it must be a coarse static label, never a tenant- or
principal-specific count; the description's first line is model-facing and
must carry no secrets or instructions.

## Argument names and request aliases (#4507, #4505)

`data.inspect`'s `surfaceId` is described ("The id data.discover lists for the
surface", `DATA_INSPECT_TOOL_PARAMETERS`) and named in its tool description;
summary discovery repeats `id` as `surfaceId`. `placeSurfaceId` takes a lone
top-level `id` string as `surfaceId` when no `surfaceId` is given and nothing
else sits beside it (inspect: no other key; query: only `request` or its
`query` wrapper, never the flat form, where `id` may be a field). Every other
`id` is ignored and the existing `DATA_QUERY_SURFACE_ID_*` errors apply.

Inside `request` (or the flat form), `data.query` maps SQL-ish aliases before
validation when the canonical key is absent: `select`→`projection` (array or
comma-separated string), `where`→`filter`, `orderBy`→`sort` (`"field desc"`
strings, comma lists, or a `{ field }` object; direction defaults to `asc`),
and `limit`/`offset`→`page.limit`/`page.offset` (merged into a `page` that
lacks them). Mapped values are validated exactly as if written canonically.
An alias beside its canonical key stays in place and fails as an unsupported
key; the error names the canonical key. Beside `request` at the top level an
alias is `DATA_QUERY_ARGUMENTS_UNEXPECTED` ("move limit inside request"). The
request schema's property descriptions name the aliases.
