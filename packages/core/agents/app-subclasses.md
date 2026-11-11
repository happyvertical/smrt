# Same-name app subclasses (#4869)

An app can replace an installed model with a subclass under its public name.
The app must have a scoped package name and import the base from its owning
package. Include both the provider and app declarations in the generated
consumer manifest and load the generated registration entry before database
access. No replacement configuration or new collection class is required.

```ts
import { Customer as CustomerBase } from '@happyvertical/smrt-commerce';
import { smrt } from '@happyvertical/smrt-core';

@smrt({})
export class AppCustomer extends CustomerBase {
  favoritePose = '';
}
export { AppCustomer as Customer };
```

Start with an empty body; add fields or override inherited methods later.
`export class Customer extends CustomerBase {}` is equivalent. For a differently
named source constructor without a matching export alias, declare
`@smrt({ name: 'Customer' })`. The named export alias must be a local value
export in the model's source module. Re-exports from another module and type
exports do not rename models.

## Identity and storage

A replacement requires a same-name inheritance edge and shared physical
storage. It inherits the provider's collection, table, columns (including
`tenant_id` and `profile_id`), configuration, and methods. Own fields and method
overrides win subject to existing exposure and storage validation. For plain/CTI models, an explicit
different table remains an independent model; STI keeps its normal shared-table
rule. Unrelated models with the same
name are not replacements. Competing sibling replacements are refused.

The effective registry contains the app identity, such as
`@my/app:Customer`. Lookup by the upstream qualified identity or its constructor,
provider collection creation, and relationships targeting the upstream identity
resolve to the app constructor. REST routes, web collection definitions, MCP and
CLI commands, generated row types, and knowledge expose the effective model once.
The raw manifest retains the upstream declaration with `replacedBy` pointing to
the effective identity, preserving schema and inheritance provenance. Runtime
replacement lookup is memoized per registry generation.

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

`src/__tests__/same-name-app-subclass.test.ts` scans an on-disk installed provider
and app with the real scanner, generates manifests and SvelteKit route files,
and runs in-process SQLite. No network server or external service is used.

| Behavior / trigger | Positive case | Failure or control | Context / executor | Contract edge / level |
| --- | --- | --- | --- | --- |
| Scan same-name subclass | Direct name and matching export alias inherit table and columns | Empty body has identical columns; alias scanner rejects type and remote exports | App build / scanner | Manifest identity / integration |
| Register replacements | Runtime constructors and either manifest arrival order select app identity | Provider-only app unchanged; existing sibling and different-table tests remain | Single process / registry | Qualified lookup and ancestry / integration |
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
