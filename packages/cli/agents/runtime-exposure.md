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

`CLIGenerator` is published at `@happyvertical/smrt-cli/generator`, a
side-effect-free subpath (the package root runs the CLI on import).
`CLIGenerator.listCommands()` returns every command the CLI serves for the
current registry in execution's resolution order: utility commands, object
commands (each, an abstract resource's read-only ones included, carries the
registration it serves as `runtimeModel` and rechecks the gate), then
the built-in commands, each with only the addresses (name, aliases) no earlier
command takes, so a built-in whose name an object command takes is listed
under its first free alias; each is tagged `source`
(`utility`, `object`, `built-in`). Execution, help and the listing share one
built-in enumeration (`loadBuiltInCommandGroups`). Unlike CLI startup the
listing does not load the working directory's manifest or import the
project's entry point, runs nothing and opens no database; listing the
built-ins imports their modules, and some import packages whose models
register on import (the `gnode` group: tenancy, jobs, users, ...).
`listCommands({ builtIns: false })` lists the utility and object commands
only and registers nothing; built-ins take only free addresses, so leaving
them out never changes which object command an address runs. A
`<name>:` prefix resolves through `resolveCommandRegistrationKey(name)`. The utility-command cache and the lazy object-command cache are both
keyed on `ObjectRegistry.getGeneration()`, so the list follows registrations
made after an earlier call. The served-surface gate
(`scripts/check-served-surface.mjs`) reads this list instead of restating the
CLI's exposure rules. Test: `src/__tests__/list-commands.test.ts`.
