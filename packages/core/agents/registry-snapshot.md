<!-- Module doc for packages/core/AGENTS.md. Linked from the Modules table there. -->

# Registry snapshot (#1831)

`src/system/registry-snapshot.ts` projects the booted, process-global
`ObjectRegistry` into `RuntimeRegistrySnapshot`, the only shape in which
registry state may cross a process or wire boundary. It is a pure read of
in-process state: no database, no project code, no registry mutation.

What leaves: per object the simple/qualified name, package, table, collection,
`extends`/type argument/inheritance chain, visibility, tenancy `{mode, field}`,
counts, and (with `detail`) fields — name, type, required, `related`,
transient, inherited, `sqlType` — and methods — name, async/static/public,
parameter names and types, return type, inherited. Registry diagnostics keep
only severity, code, and message.

What never leaves: constructors, collection constructors, validators,
validation rules, `tools` payloads, decorator config, field `value`s or
descriptions, diagnostic `context`, and absolute paths. `sourceFilePath` is
relativized to `projectRoot`; a path outside the root (installed package,
symlinked workspace) is reduced to its basename so `..` walking cannot reveal
layout. `assertPlainJson()` is exported so callers and tests prove a snapshot
is plain JSON (no functions, class instances, symbols, or cycles) rather than
trusting an allow-list.

Consumers: `smrt-dev-mcp` `tools/runtime/observation.ts` (`runtime-registry`,
`runtime-object`) and its Level 2 HTTP host. A new consumer must take the DTO,
never a `RegisteredClass`.
