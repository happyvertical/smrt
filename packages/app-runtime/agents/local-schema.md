# Local runtime: refused upgrades and removed packages (#4928)

The local profile migrates its own database at start (`src/local-schema.ts`,
`createSchema`). It has no operator: the person who sees a refusal is the app's
user, and the person who can fix it is the app's developer, who ships a build.

## The error has two audiences

`schema_migration_refused` is built from core's `describeAppMigrationRefusal`
(the CLI keeps `describeMigrationRefusal`, unchanged and asserted in core).

- `userMessage`: one short line an app may show its user. The app could not
  update its database, nothing was changed, contact the developer. No command,
  option or package name.
- `developerDetail`: the headline, one line per stop saying what the developer
  can do, and what was held back.
- `message` is the user line, a blank line, `For the app's developer:`, then the
  detail.

## Confirming a removed package: `confirmRemovedPackages`

Accepted by `initializeLocalApplicationRuntime` and by
`createSmrtSvelteKitRuntime` / `composeSmrtSvelteKitRuntime` (local profile; the
deployed profiles migrate through `smrt db:migrate` and ignore it). It reaches
`migrateSmrtSchemas({ confirmRemovedPackages })`, through the `migrateSchemas()`
the app's `prepareDatabase` gets too. Same meaning as the CLI flag: it confirms
the named packages only, a name that is not missing is ignored (a notice in the
log), and it clears nothing else. A malformed list is `invalid_configuration`.

How long to keep a name: while any installation you still support may hold a
migrate record that lists the package, that is, until every such installation
has run a build without the package (one successful start rewrites the record
without it). An installation that skips releases needs the name in the build it
jumps to, so keep it for as long as you support skipping. A stale name never
fails a start. Its only cost is that it pre-confirms a later accidental removal
of the same package, so drop it when you bring the package back.

## The other stops, on the local writer

- Release stop (the record is older than the oldest supported release): no
  option skips it. Ship a bridging build made with the smrt release named in the
  stop; installations run it first, then the build after. An installation whose
  only build is the too-new one cannot upgrade; its data is untouched.
- Build package not loaded (the stop confirming cannot clear): the package is in
  the build but the run did not import its models. Ship a build that imports
  every model before the runtime starts. Nothing was changed.
- Schema stop (a change that would lose or invent data): no option overrides it
  and the local writer has no repair step that runs before migrate
  (`prepareDatabase` runs after). Ship a build whose models do not make the
  change (for example keep the column optional). An installation holding rows
  that violate the new rule stays on the old build until then.
