# Same-name subclasses (#4869, #5143)

A class that extends a class of the same simple name from another package
replaces that parent, and says so in its own `@smrt()` options:

- `replaceParent: true`: it **replaces** the parent. One model remains.

Not declaring it is `CONFIG_SAME_NAME_SUBCLASS_UNDECLARED`, raised when the
manifest is generated (`assertSameNameSubclassChoices()`, run by
`annotateModelReplacements()` and by generated activation before it resolves
any module, so `pnpm build`, activation generation and the SvelteKit dry run
fail before publishing anything) and again when the class registers. A class
meant to stay a separate model takes a class name of its own.
`modelReplacements()` itself never throws: it also reads run-time manifests
projected from the registry, where a run-time model states replacement
through `replaces`. The option is the only input: no path infers replacement
from package names, which package is the app, the working directory, file
paths or load order. An app and a library declare it the same way and get the
same result. It is recorded in the class's manifest entry
(`decoratorConfig.replaceParent`) and its registered config, so manifest
registration and constructor registration read one fact, in the browser as in
Node. It is never inherited: a class that extends a replacement under the same
name declares its own.

`sameNameSubclassChoice()` in `src/manifest/model-replacements.ts` is the one
reading of it. The collision table (`registry/collision-policy.ts`, rows
`same-name-*`), the constructor pass in `registerUntracked`, lineage
reconciliation (`replacesAncestor`) and the build-time `modelReplacements()` /
`assertSameNameSubclassChoices()` all decide through it.

## Replacing (`replaceParent: true`)

An app, or a library, can replace an installed model with a subclass under its
public name. The declaring package must have a scoped name and import the base
from its owning package. Include both declarations in the generated consumer
manifest and load the generated registration entry before database access. No
new collection class is required.

```ts
import { Customer as CustomerBase } from '@happyvertical/smrt-commerce';
import { smrt } from '@happyvertical/smrt-core';

@smrt({ replaceParent: true })
export class AppCustomer extends CustomerBase {
  favoritePose = '';
}
export { AppCustomer as Customer };
```

Start with an empty body; add fields or override inherited methods later.
`export class Customer extends CustomerBase {}` is equivalent. For a differently
named source constructor without a matching export alias, declare
`@smrt({ name: 'Customer', replaceParent: true })`. The named export alias must
be a local value export in the model's source module. Re-exports from another
module and type exports do not rename models.

A replacement shares its parent's table: declaring `replaceParent: true` with a
different `tableName` is `CONFIG_SAME_NAME_REPLACEMENT_TABLE_MISMATCH`. The
parent's `previousQualifiedNames` follow the replacement (`getClassByQualifiedName(oldName)`
returns it); a replacement must not redeclare them. smrt-support's
`ServiceTimeEntry` replaces smrt-timesheets' this way.

## Load order

Manifest declarations arrive in either order and give one registry: base
then subclass or subclass then base, and manifest then constructor
(`registry/__tests__/issue-5143-same-name-subclass.test.ts`). A constructor
registers after the same-named class it extends (its constructor, or a
manifest declaration its own manifest names as its parent). Registering it
first fails closed with `CONFIG_SAME_NAME_PARENT_UNREGISTERED` (register the
parent before its replacement, or import its module first) and leaves
nothing registered: before the parent, nothing says what it inherits (tenancy,
table, validators, exposure), so the result would depend on load order. In a
single-table family a class whose same-named direct parent is not registered
while an ancestor is fails with the existing `CONFIG_STI_UNREGISTERED_PARENT`
(`registry/__tests__/issue-5143-load-order.test.ts`). In ESM a subclass module
imports its parent's, so the parent's decorator runs first. A run-time model
(`registerRuntimeModel`) keeps its own explicit option, `replaces`; without it
the model coexists with the parent it names, and the parent may register
again.

## Migrating

Every same-named cross-package subclass needs the option. To keep what a class
did before this rule, declare `replaceParent: true`: such a class always
replaced its parent. A class meant to be a different record type next to its
parent takes a class name of its own.

`scripts/codemod-same-name-subclass.mjs` (dependency-free; copy it into an
application to run it there) lists the classes, and with `--write` adds
`replaceParent: true` to each registration: a `@smrt()` decorator or the call
form `smrt({...})(X)`, on a class declaration or a class expression
(`const X = class X extends Base {}`), under whatever name the file imports
`smrt` as. A parent imported from a relative module counts when that module
re-exports another package's class; a relative import of a class declared in
the same package is not a cross-package subclass. A class with no
registration in its own file, or options passed as an expression, is reported
for manual edit, and the exit code stays 1 while anything is undeclared:

```sh
node scripts/codemod-same-name-subclass.mjs src          # report, exit 1 if any is undeclared
node scripts/codemod-same-name-subclass.mjs --write src  # add replaceParent: true
```

By hand, look for an import alias that is extended under its original name,
`import { Customer as CustomerBase } from '@scope/pkg'` followed by
`class Customer extends CustomerBase` (or `export { Local as Customer }`, or
`@smrt({ name: 'Customer' })`), and change `@smrt({})` to
`@smrt({ replaceParent: true })`. A class the scanner sees fails the build
(`CONFIG_SAME_NAME_SUBCLASS_UNDECLARED`); one registered only at run time (the
call form outside scanned sources, `ObjectRegistry.register`, a computed class)
fails when it registers, so run the app's tests or boot it after migrating.

## Identity and storage of a replacement

A replacement requires a same-name inheritance edge, the declared
`replaceParent: true`, and shared physical storage. It inherits the provider's collection, table, columns (including
`tenant_id` and `profile_id`), configuration, and methods. Own fields and method
overrides win subject to existing exposure and storage validation. Unrelated
models with the same name are not replacements; a same-named subclass that
declares nothing is refused rather than guessed. Competing sibling
replacements are refused.

The effective registry contains the app identity, such as
`@my/app:Customer`. Runtime lookup with `getClass(upstreamQualifiedName)` or
`getEffectiveClassByConstructor(upstreamConstructor)`,
provider collection creation, and relationships targeting the upstream identity
resolve to the app constructor. REST routes, web collection definitions, MCP and
CLI commands, generated row types, and knowledge expose the effective model once.
The raw manifest retains the upstream declaration with `replacedBy` pointing to
the effective identity, preserving schema and inheritance provenance. Runtime
replacement lookup is memoized per registry generation.
Exact inspection with `getClassByConstructor()`, `getClassByQualifiedName()` or `getClassInPackage()` keeps
the existing consumer-subtype contract: a replaced upstream registration is
absent. `resolveType()` and `resolveQualifiedName()` normalize the upstream
identity to the effective app identity. This extends the existing same-name
consumer replacement mechanism; retained declarations serve ancestry only.

Ancestry is separate from I/O lookup: a provider's `Person extends Profile`
still has its declared provider `Profile` base after the app replaces Profile.
The app's Profile collection remains the STI root and sees Person rows; Person
keeps its own constructor and discriminator. CTI children retain their own
bases and tables, and continue to redeclare inherited persisted fields under
the existing CTI contract. An ordinary differently named CTI subclass keeps the existing
CTI contract; same-name replacement does not change it.

## Schema changes

Rebuild the app manifest, then apply ordinary `smrt db:migrate` before starting
writers. New persisted fields are added to the provider's existing table; an
empty replacement leaves its columns unchanged. There is no runtime schema
creation requirement or alternate migration path. An STI family's shared table
still includes all its existing subtype columns. Existing apps without a
same-name subclass keep their previous identities and behavior.

## Validation contract

Hosted STI route selection canonicalizes the AOT provider exposure list through
same-name replacements before separating inherited route collections. Replacing
both `Contract` and `Agreement` therefore keeps `/contracts` for the app base and
`/agreements` for the app subtype, with the original `contracts.*` permission
scope. The ancestry walk reads retained provider declarations even though the
effective I/O index omits them; otherwise an empty subtype loses both its distinct
route and inherited API restrictions. The host regression generates these two
routes with collision rejection enabled and verifies that the input manifest is
unchanged. No persistence, schema or discriminator contract changes.

`src/__tests__/same-name-app-subclass.test.ts` scans an on-disk installed provider
and app with the real scanner, generates manifests and SvelteKit route files,
and runs in-process SQLite. No network server or external service is used.

| Behavior / trigger | Positive case | Failure or control | Context / executor | Contract edge / level |
| --- | --- | --- | --- | --- |
| Scan same-name subclass | Direct name and matching export alias inherit table and columns | Empty body has identical columns; alias scanner rejects type and remote exports | App build / scanner | Manifest identity / integration |
| Register replacements | Runtime constructors and either manifest arrival order select app identity | Provider-only app unchanged; existing sibling and different-table tests remain | Single process / registry | Qualified lookup and ancestry / integration |
| Declared choice (#5143) | Replace by an app or a library, in every arrival order; rows hydrate as the replacement | Missing choice is refused at generation, activation and registration, registry and published outputs unchanged | Manifest, constructor and mixed, every order / registry + SQLite; fresh-process generated activation | `issue-5143-same-name-subclass.test.ts`, `collision-policy.test.ts` (every input combination), `activation/generate-order.test.ts` / integration + unit |
| SQLite custom field | Manifest differ emits ALTER on provider table; REST create/get/list/update/delete round-trip field | Repeated migration emits nothing; deleted record returns 404 | Public fixture / one SQLite handle | REST DTO and normal migration DDL / integration |
| Relationship loading | Invoice resolves app Customer and custom field | Missing/deleted target behavior remains covered by existing relationship suite | Fixture relationship / same SQLite handle | Qualified target / integration |
| STI and CTI | Provider children retain bases; STI root lists provider child; CTI tables round-trip | CTI child retains its separate table and declared columns | App and provider / same SQLite handle | Ancestry, discriminator and schema / integration |
| Generation | One app REST/web/MCP/knowledge identity; CLI field options include custom and inherited fields | No duplicate upstream surface | Build and CLI / no network | Generated routes, tools, types / integration |

Commands: `pnpm --filter @happyvertical/smrt-core test`, scanner `pnpm test`, and
CLI `pnpm test`, plus package builds/typechecks and root lint, format and strict
knowledge checks. Transaction rollback and auth policy are unchanged: this
capability chooses model identity and schema metadata, while existing CRUD,
transaction and tenant guards continue to own mutation authorization/atomicity.
SQLite is the executed persistence contract for this fixture; the schema metadata
is engine-neutral, but this fixture does not claim PostgreSQL or DuckDB execution.

Cookbook host generation now composes these replacement rules in the public
`smrt-template-sveltekit/host/generate` entry. Core's consumer-plugin export
`aliasHostedCollections` applies a host URL namespace after STI separation and
before snapshot serialization. It preserves `permissionCollection`, table
metadata and provider input, and moves a model's collection class with it.
