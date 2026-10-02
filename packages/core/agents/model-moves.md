# Moving a model between packages (#3338)

A class's registry identity is its qualified name, `@package/name:ClassName`.
Moving a class to another package (or renaming it) changes that name, and every
reference that stored or declared the old one stops resolving silently:
polymorphic `metaType` rows (including smrt-assets `AssetAssociation`),
`ObjectRegistry.getClassByQualifiedName()`, `@crossPackageRef` and relationship
targets, and playbook step `model:` names.

## Declare the old name

```ts
@smrt({
  tableName: 'service_time_entries', // keep the table: a move is not a rename
  previousQualifiedNames: ['@happyvertical/smrt-projects:ServiceTimeEntry'],
})
export class ServiceTimeEntry extends SmrtObject {}
```

`previousQualifiedNames` (`registry/types.ts`) is a list of deprecated
qualified names. Keep `tableName` explicit so the moved class keeps its table.

## What the alias does

- **Resolution.** `registry/qualified-name-aliases.ts` derives an alias index
  from registered classes once per registry generation. `findClass()`,
  `findClassStrict()`, `getClassByQualifiedName()`, `getClassInPackage()` and
  `resolveType()` consult it after a direct miss, for qualified input only;
  simple-name lookups are unchanged. `resolveType(old)` returns the current
  name.
- **Lazy path.** `tryLoadFromExternalPackage(old)` falls back to the alias
  index the NEW owner's manifest carries: the scanner keeps
  `decoratorConfig.previousQualifiedNames` verbatim, so the old identity
  resolves even when the old package no longer lists the class or is not
  installed. Loaded manifests are searched first, then discovered packages.
  `ensureManifestLoaded(old)` reconciles under the current name.
- **Covered call sites.** `SmrtPolymorphicAssociation.hydrate()`, relationship
  targets (`relationship-graph.ts` resolves `@crossPackageRef('<old>')` to the
  current name, so loads, inverses and delete planning key on it), delete
  cascades (`cascade.ts` also removes association rows stored under an old
  name), and playbook preflight (`resolveRegisteredObjectName`).
- **Deprecation warning.** The first resolution of each old name per process
  logs a warning naming the old name, the current name, and the resolution
  site, and records a `QUALIFIED_NAME_ALIAS_DEPRECATED` registry diagnostic.
  `ObjectRegistry.clear()` resets it.
- **New writes store the current name.** `SmrtPolymorphicAssociation.save()`
  rewrites an aliased `metaType`; a legacy row that is loaded and saved again
  is upgraded. Readers that filter on stored names use
  `ObjectRegistry.getEquivalentQualifiedNames(name)`, which returns the
  current name followed by the aliases, as `AssetAssociationCollection`'s
  `byLeft()`, `detach()` and `setLinks()` do.
- **Public helpers.** `ObjectRegistry.getQualifiedNameAliases()` returns the
  alias-to-current map, and `resolveQualifiedName(name)` returns the current
  name.

## An alias is never a second class

Alias keys never enter the `classes` map. `getAllClasses()`, schema/DDL,
MCP/CLI/REST generation, knowledge surfaces and every other iteration see one
entry per class. Registration refuses ambiguity with
`CONFIG_QUALIFIED_NAME_ALIAS_COLLISION` when an alias equals a live class's
qualified name (in either registration order) or when two classes claim one old
name. It refuses `CONFIG_QUALIFIED_NAME_ALIAS_INVALID` when an entry is not
`<package>:<ClassName>`, repeats, or names the class itself. Manifest generation
(`ManifestGenerator.assertQualifiedNameAliases`) fails closed on the same
mistakes. The knowledge artifact lists the names as
`objects[].previousQualifiedNames`, sorted and omitted when empty.

## Stored references: doctor and backfill

`migrations/qualified-name-aliases.ts`, exported from
`@happyvertical/smrt-core/migrations`, covers two kinds of stored reference:
`meta_type` on every registered polymorphic-association table, and `_meta_type`
on the STI table of an aliased STI class.

- `countLegacyQualifiedNameReferences(db, { tenantId? })` is read-only and
  returns counts by table, column and old name. `smrt doctor --db` prints them
  under "Deprecated Qualified Names" and warns while the count is non-zero.
- `backfillLegacyQualifiedNames(db, { dryRun?, tenantId?, force? })`, run as
  `smrt db:migrate-qualified-names`, is opt-in and never automatic. It rewrites
  only exact old-name values, in one transaction where available, and never
  touches ids or tenant columns. A `tenantId` run only touches that tenant's
  rows in tenant-owned tables. It skips and reports any row whose rewrite would
  duplicate a current-name row on the table's conflict columns. Once nothing in
  scope remains, it records a `_smrt_backfills` marker named
  `@happyvertical/smrt-core:qualified-name-aliases:v1:<digest>[:tenant:<id>]`.
  The digest covers the alias set, so a later move runs again.

Known gap: STI child-collection reads filter `_meta_type` by the current name
only. Run the backfill before relying on subclass collections of a moved STI
class.

## Lifecycle

1. Move the class, keep its table, and declare `previousQualifiedNames`. This
   needs no data migration.
2. Consumers upgrade. Old names keep resolving and warn once per process.
3. Optionally run `smrt db:migrate-qualified-names` to clean up early.
4. Remove the alias in a later **breaking** release, only once
   `smrt doctor --db` reports zero stored references for every consumer and no
   consumer source still declares the old name.
