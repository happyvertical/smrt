# Static decorator config and fail-closed scans

What the scanner reads from decorators, how it resolves a class's parent, and
when a scan fails. Source: `src/oxc-parser.ts` (reader), `src/manifest-adapter.ts`
(conversion), `src/inheritance-resolver.ts` (classes and parents).

## The rule

A value reaches the manifest **in full**, or the scan reports an
`severity: 'error'` diagnostic naming the file, the class, the member and the
option path. There is no third state: a supplied config never reads as `{}`,
an option never reads as the name of the identifier that held it, and one
unreadable value never discards the options beside it.

Every producer fails on those diagnostics: `smrtPlugin` and `ManifestBuilder`
abort the build, `verifyManifestCompleteness` returns `scan-error`, and
`smrt-scan` exits non-zero without writing a manifest. A caller that converts
anyway must check `ScanResults.errors` first.

Nothing is evaluated. The reader walks the OXC AST; no source text is run at
scan time, in the parser or in `ManifestAdapter`.

Why it matters: an absent `api`/`mcp`/`cli` key means default-open CRUD, an
absent `sensitive` flag means the field is emitted to web field sets and tool
schemas, an absent `transient` flag becomes a column, an absent `onDelete`
takes the natural-key default, and an absent model is a missing table.

## Decorators read

| Kind | Decorators |
| --- | --- |
| Class | `@smrt`, `@TenantScoped`, `@report` |
| Method | `@method` |
| Field options | `@field`, `@meta`, `@tenantId`; second argument of `@foreignKey`, `@oneToMany`, `@manyToMany`, `@crossPackageRef` |
| Field text | `@crossPackageRef` qualified name; `@groupBy`, `@sum`, `@avg`, `@min`, `@max`, `@count` column; `@minute` … `@year` column |
| Static properties | `uiSlots`, `adminRoutes`, `signalSubscriptions`, `createEntries` |

A decorator is recognized by the name it is **exported** under: a direct
import, an alias (`import { field as f }`), or a namespace
(`import * as core` then `@core.field()` or `@(core['field'])()`).
`RawDecorator.name` is that name. A computed namespace member keyed by a
same-file string constant (`@(core[KEY])()` with `const KEY = 'smrt'`) reads
as that export. One the scanner cannot name (`let KEY`) is a scan error on a
class, a method or a field: it may be `@smrt`, `@TenantScoped`, `@method` or
a field decorator whose configuration would be lost. On a class it is
reported whether or not the class otherwise reaches the manifest, since it
may be the decorator that makes it a model.
A member of anything other than a namespace import is not a decorator call
the scanner reads.

## Value forms

| Form | Result |
| --- | --- |
| String, number, boolean, `null` literal; `undefined` | read |
| `-x`, `+x`, `!x` over a static value; `+ - * / % **` over numbers; string concatenation | read (folded) |
| `Infinity`, `NaN`, or any value or folded result that is not a finite number | **error** (JSON writes it as `null`, which clears a limit) |
| Template literal, with or without substitutions of static scalars | read |
| Object and array literals of static values, nested; numeric keys (`{ 0: 'draft' }`) by their string form; the empty-string key `''` | read |
| `as const`, `as T`, `satisfies T`, `<T>x`, `x!`, parentheses | transparent |
| Identifier naming a same-file module-scope `const` scalar, array or object | read |
| Member of such a constant object (`LIMITS.max`, `LIMITS['max']`); same-file `enum` member | read |
| Shorthand property naming such a constant (`{ readPermission }`) | read |
| Object spread of a constant object or inline object, at any depth | read |
| Array spread of a constant array or inline array | read |
| Whole argument given as a constant (`@smrt(CONFIG)`, `@field(SECRET)`, `static uiSlots = SLOTS`) | read (a static property must be the constant's only reader, see below) |
| Regular-expression literal | read as the same `RegExp` (JSON form `{}`, as before) |
| `new Date(<static arguments>)` | read as that `Date` (JSON form: ISO string) |
| Relationship target: `'Name'`, class reference `Target` / `ns.Target`, `() => Target` thunk, same-file string or thunk constant | by reference: recorded by the class's own name (see "Class references") |
| `@report` `source` and `joins.*.source` given as a class reference | by reference: recorded by the class's own name |
| Class reference that does not resolve to one class (see "Module resolution"); a local alias or `let`; an empty or blank target | **error** |
| `validate` on `@field` / `@meta` given as a function or a function reference | by reference: listed in `_meta.__statedOptions`, no value emitted |
| Imported identifier or member of an import | **error** |
| `let` / `var` / function-scoped binding; destructured `const` | **error** |
| Call, `new X()` other than a static `Date`, `new Date()` | **error** |
| Function value under any other option, or under `validate` on any other decorator (`default: () => x`) | **error** |
| Conditional, logical, tagged template, bigint, computed non-literal key, a key that is not a string or finite number | **error** |
| Spread of anything that is not a readable object or array | **error** |
| Relationship target that names no class (a call, a conditional) | **error** |

Fix for an error: inline the value, or declare it as a module-scope `const`
literal in the same file. Imports are not followed.

## Module constants and mutation

`const` prevents rebinding, not mutation, and a decorator may receive the
constant itself rather than a copy. The snapshot of a constant's initializer
is trusted only while nothing in the module can change the object:

- A scalar constant is immutable. One read from an object constant's member
  (`const S = POLICY.sensitive`) carries that object's taint: a write to the
  object anywhere in the module taints the scalar too.
- An object or array constant is trusted when every reference to it is a
  read the scanner understands: a spread, a value or member read inside a
  read decorator's argument, a manifest static property initializer, or
  another module constant's initializer.
- Any other reference (assignment through it, a method call on it, passing
  it to a function, an alias) taints the constant. A decorator that uses a
  tainted constant reports the tainting expression.
- A spread copy with no nested objects is unaffected by a mutation written
  after it. A constant passed or nested by reference is affected wherever the
  mutation is written.
- Taint follows constants built from constants, in both directions when
  nested values are shared.
- A manifest static property that holds a constant (`static uiSlots =
  SLOTS`) keeps a second, writable reference on the class, which runtime code
  reaches through the class or `this.constructor`. It reaches every object of
  the constant's group: constants it holds by reference or spreads with nested
  objects, constants that hold one of those, transitively. It is trusted only
  when it is the sole reader of that whole group (references inside the
  group's own object initializers do not count; a scalar copied out of the
  group, `const S = POLICY.sensitive`, is a reader); otherwise the static
  reference taints the group.
- An unused tainted constant reports nothing.

Each class gets its own copy of a constant's nested values.

`extractModuleObjectConstants` is the raw-shape reader used by
`ui-selectors.ts`: object constants only, identifiers recorded as source text,
nothing resolved. It is not the decorator reader.

## Runtime-only options

`validate` on `@field` (and `@meta`, which takes the same options) is a custom
validator function the runtime holds. A manifest cannot carry a function. The
parser replaces the value with `RUNTIME_ONLY_OPTION`; `ManifestAdapter` lists
the key in `_meta.__statedOptions` and emits no value. The rule is keyed on the
decorator, not the option name (`runtimeOnlyFieldOptions` in
`src/oxc-parser.ts`): on `@crossPackageRef`, `validate` is the boolean that
turns on save-time checking and is read like any option, so an imported,
`let` or computed value is a scan error; on every other decorator, and in
static initializers, nothing is runtime-only. Add a decorator or option here
only when the runtime reads it as a callback.

## Classes without `@smrt()`

Diagnostics for field decorators and static properties of a class without
`@smrt()` are held on `RawClassDefinition.configErrors`. `OxcScanner.resolve()`
moves them into `ScanResults.errors` for every class that reaches the
manifest (and for the ancestors a single-table model merges fields from). A
class that is not part of any model, using a same-named decorator from another
library, reports nothing. Code that calls `parseFile`/`parseSource` and
resolves classes itself must read `configErrors`.

## Hand-built decorators

`RawDecorator.argumentValues` carries each argument as the parser read it. A
hand-built `RawDecorator` has only `arguments` (source text);
`ManifestAdapter` reads that text with the same rules through
`parseStaticLiteralSource` and **throws** on a value it cannot read. A text
position (a column, a qualified name, an aggregate's first argument) accepts a
string literal, or an options object only where the decorator has an object
overload (an aggregate's first argument); an identifier (`STATUS`, `OPTIONS`)
or an object elsewhere (`@month({…})`, `@crossPackageRef({…})`) throws. An
empty or blank relationship target throws.

## Import proof

Parents (`extends`), relationship targets, `@report` `source` /
`joins.*.source` and a collection's item (`SmrtCollection<Item>`) are
accepted only in forms the scan proves from source (`src/import-proof.ts`).
Nothing is resolved through an alias, a barrel, a re-export, `baseUrl`, an
imports map or a bundler config, and no class is ever matched by name:

| Form | Proof | Recorded as |
| --- | --- | --- |
| A class declared in the same file | the file's own declarations | its name |
| A named or default import whose relative specifier selects a scanned file that declares the class and exports it under its own name (`export class X`, `export default class X`, `class X` + `export { X }`) | the file TypeScript selects: its candidate order (extension substitution, `.ts`/`.tsx`/`.d.ts`, directory `index`, then `.js`/`.jsx`; within each extension every entry of the project's `moduleSuffixes`, so `['.ios', '']` tries `Base.ios.ts`, `Base.ts`, `Base.ios.tsx`, `Base.tsx`, ...), first file on disk | the declaring class's name (`import { Account as Owner }` gives `Account`) |
| A framework base exported by `@happyvertical/smrt-core` (`SmrtReport`, `SmrtReportCollection` by `@happyvertical/smrt-reports`) | the package name; inside the framework package, its own sources | framework |
| A named import or namespace member (`ns.X`, `ns['X']`) from `@scope/pkg` or `@scope/pkg/subpath`, where `@scope/pkg` is declared in `dependencies`, `peerDependencies`, `optionalDependencies` or `devDependencies` of the nearest `package.json` above the importing file and is not that package itself | the declaration; the copy the file loads is the copy the build root loads | `extendsQualified` / `relatedQualified` / `sourceQualified` / `extendsTypeArgQualified` = `@scope/pkg:X`, plus the full specifier (`extendsImportPath`, `relatedImportPath`, `sourceImportPath`, `extendsTypeArgImportPath`) |

Everything else is a scan error whose message names the fix: a relative file
that re-exports, passes on an import, renames (`export { Other as X }`) or
does not declare the class; a file outside the scan, a declaration file or
JavaScript (the first candidate on disk decides, never a later one); a
non-relative specifier that is not a declared scoped package (a `paths`
alias, a `baseUrl` import, `#imports`, an unscoped package); the package's own
name; a package's default export; an unimported global (`SmrtObject` without
its import is not the framework base); two installed copies of a package; a
superclass written as anything but `X` / `ns.X` (`X as T`, `X!`, a call, a
member of a class or other value such as `Base.Inner` or `Base['Inner']`: a
TypeScript wrapper is looked through so an undecorated collection still
reaches the manifest, and is then reported). A relationship target written as
a class member in code (`Target.column`, `() => Target.column`) is an error
too: the runtime decorator receives the property, not a class. A column is
named with the string form `'Target.column'`.

A model's chain must be made of models: an undecorated scanned class counts as
one only when its own chain reaches a framework base (or a configured base)
through scanned classes alone. A decorated class over an undecorated class
that extends another package's class, or over a plain class, is an error
suggesting `@smrt({ abstract: true })`. A relationship target, report source
or collection item that proves to a scanned class must be a model too (a
same-file target is checked the same way), and a reference to a stand-in for
another package (`@smrt({ packageName })`) is an error. A static `_itemClass`
must name the class the collection's type argument names.

A class named like a framework base is the framework base only when the
framework package declares it; in any other package it is an ordinary class,
recorded with this package's `extendsQualified`.

A package export is confirmed at generation against that package's manifest,
including that the specifier is the entry the manifest records the class at
(`importPath`); see [build-knowledge.md](../../core/agents/build-knowledge.md).
On the provider side, every scan checks its own exports: an export named like
one of the scan's models must be that model's own declaration, followed
through the scan's relative re-exports the way ES modules resolve them: `export
*` paths that reach the same declaration agree, a cycle of `export *` ends, and
two paths reaching different classes leave the name ambiguous, which is an
error. A rename, another class re-exported
under the name, or a named re-export from another package is an error. A file
that declares its own class of a model's name and exports it as itself is
another class at another path and is allowed.

Only references of models, and of the ancestors whose fields reach a model,
are proven and reported. A class registered without its module (a hand-built
definition) keeps the older name-based parent lookup. A scanner run twice
replaces the first run's classes (`InheritanceResolver.clearClasses`) and
reads `package.json` and `tsconfig.json` again.

## Classes and parents

A class is identified by its file and its name. Two files may declare a class
of the same name; neither replaces the other.

Two classes of one package that both reach the manifest (decorated, or
derived from a framework base) under one name are a `Class name collision`
diagnostic naming every file, and `ManifestAdapter.toManifest` throws on the
same condition.

A class that declares another package with a literal
`@smrt({ packageName })` — a test fixture standing in for an app or an
upstream package — is compared with that package's classes only. The manifest
still keys it under the scanned package, so when it meets the scanned
package's own class of the same name, the own class is the entry, whatever
the file order. Two stand-ins for different packages under one name cannot
share the key: `toManifest` throws, and one of them must be kept out of the
scan.

A single-table child whose parent is a package export gets the parent's
fields and manifest static metadata (`uiSlots`, `adminRoutes`, …) from
generation, which merges them from the parent it confirms.

An undecorated class whose parent is imported from another package is a model
only when the caller passes that parent as a base class (`baseClasses`); it
keeps the parent's package identity, which generation confirms. A framework
base name in `baseClasses` changes nothing: only its import from the framework
package makes it the framework base. Core's handling of a decorated class
whose imported parent no manifest declares is in
[build-knowledge.md](../../core/agents/build-knowledge.md).

## Build failures and their fixes

Each of these used to produce a manifest that disagreed with the source, and
now stops the build. The message names the file, class and member.

| Failure | Fix |
| --- | --- |
| A decorator value the scanner cannot read (an imported constant, a call, a `let`, `new Date()`, a function other than a field `validate`, `Infinity`/`NaN`) | Inline it, or declare it as a same-file module `const` that nothing writes to |
| A constant shared by a manifest static property (`uiSlots` etc.) and any other reader | Give the static property its own constant |
| A computed namespace decorator the scanner cannot name (`@(core[key])()`), including a key copied from an object member a module statement writes | Use `@core.smrt()` / `@(core['smrt'])()`, or a same-file string constant key nothing writes |
| Two models of one class name in a package | Rename one |
| A parent, relationship target, report source or collection item imported through a relative barrel, `export *`, `export { A } from`, an import passed on, a default re-export or a renamed export | Import it from the file that declares it |
| ... imported through a tsconfig `paths` alias, a `baseUrl` bare import, `$lib`, `@/`, `~`, `#imports` or a bundler alias | Import it by relative path from the declaring file |
| ... from an unscoped package, or a scoped package not declared in the nearest `package.json` | Declare the package as a dependency (SMRT packages are scoped) |
| ... through the package's own name | Import your own classes by relative path |
| ... from a file the scan does not read, a declaration file or JavaScript (TypeScript's first candidate on disk) | Add the file to the scan include, or move the class |
| ... from a package of which two different copies are installed (the importing file's and the build root's) | Install one copy |
| A default import from a package, or an unimported global named like a framework base | Import the class by its name (`import { SmrtObject } from '@happyvertical/smrt-core'`) |
| A superclass written as anything but `X` or `ns.X` (`X as T`, `X!`, `X satisfies T`, `Mixin(X)`, `Base.Inner`, `Base['Inner']`) | Write `extends X`, importing the parent class by its name |
| A relationship target written as a class member (`@foreignKey(Target.column)`, `() => Target.column`) | Name the class, or the column as a string: `@foreignKey('Target.column')` |
| A model whose chain passes through a scanned class that is not a model (a plain class, or an undecorated class over another package's class) | Decorate it with `@smrt({ abstract: true })`, or extend the model directly |
| A relationship target, report source or collection item that is a plain class, or a stand-in for another package | Reference the model class |
| A static `_itemClass` naming another class than `SmrtCollection<Item>` | Name the same model in both |
| A module exporting another binding under a model's class name (`export { Other as Model }`, `export { Model } from '@other/pkg'`, a barrel re-exporting a plain class of the name) | Export each model under its own class name; rename the other class |
| `CONFIG_UNRESOLVED_IMPORTED_PARENT`: a parent (or collection item) from another package whose manifest does not declare it, that is installed without a manifest, whose manifest records no `importPath`, that is imported from another entry than the one the manifest records, or that the package only re-exports; or an `extendsQualified` that is not a qualified name | Import it from the package that declares it, at the entry its manifest records; build that package with this version so its manifest exists; declare it as a dependency |
| `CONFIG_UNKNOWN_RELATIONSHIP_TARGET`: a relationship target or report source that names no model of the package or a loadable dependency, or a package export that cannot be confirmed (as above) | Import the model class itself from its declaring package and entry, or name a declared model |
| `CONFIG_AMBIGUOUS_RELATIONSHIP_TARGET`: a target or report source imported from another package whose simple name another class of this package, or of a dependency generation reads, also declares (an app class that extends it and shares its table excepted) | Rename one of the classes, or reference this package's class |
| An empty `@foreignKey('')` target | Name the related model |
| Hand-built `RawDecorator` text that is not a literal where a literal is required | Pass a string literal, or the options object where the decorator takes one |
| `smrt-scan` with a target, parent or collection item from another package (a name qualified with another package included), or a target no scanned class declares | Build with `ManifestBuilder` or the Vite plugin, which read dependency manifests |

## Upgrading: foreign keys to another package's model

A foreign key to another package's model, and one a child inherits from a
provider's single-table class, now keeps its constraint (the provider's
table, the referenced column, the declared `onDelete`); before, generation
dropped it. A target written with a column (`'Room.code'`) keeps that column
and the child column takes its type. The schema version and fingerprint of
the affected models change, so a deployed database needs a migrate.

`smrt db:migrate` adds each missing constraint once per physical table, even
when several classes share that table. On PostgreSQL `ADD CONSTRAINT` checks
every existing row (`db:migrate`'s orphan probe stops before it and prints a
repair), and on SQLite and DuckDB the table is rebuilt with the constraint, so
**adding a constraint to a table that has orphan rows fails**. Find and repair
orphans first (`smrt db:orphans` counts them for every foreign key), then
migrate. The constraints this release adds in this repository and its known
consumers, with a check for each (each should return no rows):

| Table and column | References | Who | Orphan check |
| --- | --- | --- | --- |
| `assets.folder_id` | `folders.id`, `NO ACTION` | `smrt-images` `Image`, the `smrt-video` asset classes (the `smrt-assets` schema of the shared `assets` table already declares it) | `SELECT a.id, a.folder_id FROM assets a LEFT JOIN folders f ON f.id = a.folder_id WHERE a.folder_id IS NOT NULL AND f.id IS NULL;` |
| `work_orders.production_run_id` | `manufacturing_production_runs.id`, `RESTRICT` | apps/office `WorkOrder` | `SELECT w.id, w.production_run_id FROM work_orders w LEFT JOIN manufacturing_production_runs r ON r.id = w.production_run_id WHERE w.production_run_id IS NOT NULL AND r.id IS NULL;` |
| `products.default_operation_id` | `manufacturing_operations.id`, `RESTRICT` | apps/office `ShopAssembly` (single-table child of `smrt-manufacturing`'s `Assembly`, whose schema already declares it) | `SELECT p.id, p.default_operation_id FROM products p LEFT JOIN manufacturing_operations o ON o.id = p.default_operation_id WHERE p.default_operation_id IS NOT NULL AND o.id IS NULL;` |

Repair each orphan by pointing it at an existing row or setting the column to
`NULL` (an empty string is an orphan too), then run `smrt db:migrate`. A
`RESTRICT` constraint then also refuses deleting a referenced row; delete or
reassign the referencing rows first.
