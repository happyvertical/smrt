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

## Module resolution

Parents (`extends`), relationship targets and `@report` `source` /
`joins.*.source` written as classes are resolved by one module resolver
(`src/module-resolver.ts`), never by matching a class name:

- **The specifier** names one module: a relative path (TypeScript's
  extension and `index` rules); a project path alias declared in
  `tsconfig.json` `compilerOptions.paths` (following relative `extends`;
  an alias wins over an installed package of the same name, as it does for
  TypeScript); otherwise a package, by its npm name. A specifier that is
  neither a scanned file nor a valid package name (`$lib/…` without a
  `paths` entry, `@/x`) does not resolve: an alias declared only in a
  bundler config is not read.
- **The binding** is followed inside scanned modules through
  `export { A as B }`, `export { A }` of an import, `export { A } from`,
  `export *` and default exports, to the declaring class. A private class of
  the same name in a barrel is not its export. `ns.X` and `ns['X']` are the
  same binding.
- **The result** is the declaring class (file, name, package), or a package
  export (`@pkg:Export`) that generation confirms against that package's
  manifest. A framework base is one only when the binding is
  `@happyvertical/smrt-core`'s export (or, unimported and undeclared, its
  global name); a default import named `SmrtObject` is not.
- **Anything else is a scan error**: a module outside the scan, an export
  that is not a class (a string constant), a package's default export (a
  manifest does not record which class that is), two `export *` sources of
  one name. No simple-name match in the app or any dependency is ever a
  fallback.

A relationship target or report source is recorded by the declaring class's
own name (`export { Account as OwnerModel }` gives `Account`); a package
target keeps its identity in `relatedQualified` / `sourceQualified`, which
generation confirms and replaces by the declaring class
(`CONFIG_UNKNOWN_RELATIONSHIP_TARGET` otherwise). Only references of models,
and of ancestors whose fields reach a model, are resolved and reported. A
class registered without its module (a hand-built definition) keeps the
older name-based parent lookup. A scanner run twice replaces the first run's
classes (`InheritanceResolver.clearClasses`).

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

A single-table child whose parent is a package export (including its own
package, imported by name) gets the parent's fields and manifest static
metadata (`uiSlots`, `adminRoutes`, …) from generation, which merges them
from the parent it confirms.

An undecorated class whose parent is imported from another package is a model
only when the caller passes that parent as a base class or external manifest
(`baseClasses`, `externalManifests`). Core's handling of a decorated class
whose imported parent no manifest declares is in
[build-knowledge.md](../../core/agents/build-knowledge.md).

## Build failures and their fixes

Each of these used to produce a manifest that disagreed with the source, and
now stops the build. The message names the file, class and member.

| Failure | Fix |
| --- | --- |
| A decorator value the scanner cannot read (an imported constant, a call, a `let`, `new Date()`, a function other than a field `validate`, `Infinity`/`NaN`) | Inline it, or declare it as a same-file module `const` that nothing writes to |
| A constant shared by a manifest static property (`uiSlots` etc.) and any other reader | Give the static property its own constant |
| A computed namespace decorator the scanner cannot name (`@(core[key])()`) | Use `@core.smrt()` / `@(core['smrt'])()`, or a same-file string constant key |
| Two models of one class name in a package | Rename one |
| A parent, relationship target or report source that does not resolve to one class: a default import from a package, a module outside the scan, an export that is not a class, an alias declared only in a bundler config | Import the class by its name from the module that declares it; declare path aliases in `tsconfig.json` `paths` |
| `CONFIG_UNRESOLVED_IMPORTED_PARENT`: a parent from another package whose manifest does not declare it (or that is installed without a manifest) | Build the parent's package, make it a dependency, and import the parent by its class name |
| `CONFIG_UNKNOWN_RELATIONSHIP_TARGET`: a relationship target or report source that names no model of the package or a loadable dependency (including a package export the package does not declare) | Import the model class itself, or name a declared model; declare the providing package as a dependency |
| An empty `@foreignKey('')` target | Name the related model |
| Hand-built `RawDecorator` text that is not a literal where a literal is required | Pass a string literal, or the options object where the decorator takes one |
| `smrt-scan` with a target or parent from another package, or a target no scanned class declares | Build with `ManifestBuilder` or the Vite plugin, which read dependency manifests |
