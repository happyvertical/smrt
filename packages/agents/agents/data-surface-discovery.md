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
return only `id`, a cleaned `label`, the description's first non-empty line
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
