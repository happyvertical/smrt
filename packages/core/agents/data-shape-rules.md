# Data shape rules (#4920)

Who decides what a table looks like: the app does. smrt requires a field only
when its own code needs it, and says why. This file holds the seven rules, how
smrt keeps each one, and how an app hardens a smrt class. It is the standing
policy, not a transition step.

Marks in this file: **Not built yet** means the check is planned and has an
issue. Do not rely on it.

## The rules

1. **smrt requires a field only when its own code would be wrong or unsafe
   without it.** Typical cases are ids, tenant scoping, idempotency and
   duplicate-detection keys, state a smrt service steps through, and the
   `_smrt_*` tables. Everything else is optional. Every required field in a
   smrt package states its reason (`requiredFor`). Every smrt model is tested
   against a row that holds only its required fields.
2. **Shape is declared only in what an app registers with smrt:** model
   classes, including the app's own subclasses, and run-time model definitions.
   The live database is never a source of shape. A constraint added to the
   database by hand is removed on the next migrate. To keep it, declare it.
3. **An app hardens a smrt class by overriding fields on a subclass.** A
   subclass with the same name as the smrt class replaces it everywhere in the
   app, so its rules apply to every row, including rows smrt's own collections
   create. A subclass with a different name is a new, stricter kind next to the
   smrt class. An app does not subclass a class it has no rule for.
4. **Migrate makes the database match the code without asking, whenever that
   is safe.** Safe means no data is lost and migrate sees every package it
   saw last time. A missing package is a stop. Removing one on purpose is
   confirmed by name. This is standing policy.
5. **Migrate stops only when it would lose or invent data.** For example, a
   field declared required while existing rows are empty.
6. **Every release upgrades, unattended, a database made by the previous
   release and by the oldest supported release.** The oldest supported release
   moves only by a recorded decision tied to deleting old upgrade code, never
   because time passed. Migrate refuses a database older than that release and
   names it. The test databases hold rows with only their required fields.
7. **Migrate is all or nothing, and new code waits for it.** Migrate works out
   every change first. If any change stops, it applies none, and says what
   stopped and what is held back. smrt does not start new code against a
   database that was not migrated for that build. `--postgres-safe` index
   builds are the one declared exception.

## How each rule is kept

A **build check** reads declarations. A **test** runs smrt's code.
**`smrt doctor --db`** reads one live database and tells an app owner what
migrate will do before they deploy.

| Rule | Build check | Test | `smrt doctor --db` |
|---|---|---|---|
| 1 | `scripts/check-required-reasons.mjs` (in `pnpm lint` and CI): a required field a caller must supply states `requiredFor` or sits in `scripts/required-reasons-baseline.json`, which only shrinks | `registerMinimalRowTests()` from `@happyvertical/smrt-vitest/minimal-row`: one generated `minimal-row.generated.test.ts` per model package saves each model from its required fields alone. Known gaps sit in `packages/vitest/src/minimal-row-expected-failures.ts`, which only shrinks | None. A live database cannot show why a field is required |
| 2 | `scripts/check-hand-written-ddl.mjs` (in `pnpm lint` and CI): hand-written `CREATE`, `ALTER` or `DROP TABLE` outside the migrator, the schema code and core's `system/` tables fails; existing ones sit in `scripts/hand-written-ddl-baseline.json`, which only shrinks | PostgreSQL: a `NOT NULL` added by hand to a column the code declares nullable is dropped by migrate (`issue-2369-postgres-column-drift.optional.test.ts`, #4897). SQLite and DuckDB: **not built yet** (#4937) | **Not built yet** (#4934): list the hand-made constraints the next migrate removes |
| 3 | None. It is behaviour, not declaration. The one refusal is a build error (below) | `issue-4932-hardening-end-to-end.test.ts` (a stricter subclass refuses a save without the field; the own-table column is `NOT NULL`), `issue-4921-same-name-subclass.test.ts` (smrt's collections build the app's class), `issue-4932-required-loosening.test.ts` (the build refuses loosening a field smrt needs), `issue-4932-sti-hardening.test.ts` (shared-table rule as a PostgreSQL `CHECK`) | **Not built yet** (#4934): list rules declared in code that the database does not enforce, and why |
| 4 | None | `change-kinds.test.ts`: one table, `SCHEMA_CHANGE_KINDS`, lists every kind of schema change as apply, report or stop; a kind with no entry fails. `packages-seen-orchestrate.test.ts` and `db-migrate-packages-seen.test.ts`: migrate with one package left out stops and changes nothing | **Not built yet** (#4934): show what the next migrate applies, and the packages the last migrate saw against those loaded now |
| 5 | None | The same table: every stop says `loses-data` or `invents-data`, and its message names the table and column | **Not built yet** (#4934): show what the next migrate stops on, with row counts |
| 6 | None | **Not built yet** (#4933): the release upgrade gate | **Not built yet** (#4934): warn when the database is older than the oldest supported release |
| 7 | None | `db-migrate-all-or-nothing.test.ts` and `db-migrate-atomic.test.ts`: one stop plus other changes leaves the database identical; a failure part-way rolls back. `issue-4929-startup.test.ts`: production refuses an unmigrated database. `db-migrate-postgres-safe.optional.test.ts`: an index failure exits with an error and a rerun finishes it | **Not built yet** (#4934): show the build's schema fingerprint next to the database's |

Rule 1 is enforced as far as the audit has gone. Fields smrt has not audited
yet are in the baseline; each one is an open question, not a reason.

## How an app hardens a smrt class

One mechanism: a subclass that overrides fields with smrt's ordinary
decorators. The name decides the reach.

| The app writes | It means |
|---|---|
| A subclass with the **same name** as the smrt class | Every object of that class in this app follows the rule. The app's class replaces smrt's everywhere, on the same table |
| A subclass with a **different name** | A stricter kind next to the smrt class. Rows of the smrt class stay as they were |

Example. A smrt `Profile` does not need an email. This app does:

```ts
import { field, smrt } from '@happyvertical/smrt-core';
import { Profile as SmrtProfile } from '@happyvertical/smrt-profiles';

// Same name: every profile in this app needs an email.
@smrt()
export class Profile extends SmrtProfile {
  @field({ required: true })
  override email: string = '';
}

// Different name: a stricter kind next to Profile.
@smrt()
export class StaffProfile extends Profile {
  @field({ required: true })
  department: string = '';
}
```

What you get:

- A save without `email` is refused in code, on every engine, including when a
  smrt collection creates the row.
- The build reads the decorators into the manifest. The running app and
  `smrt db:migrate` both read the manifest, so one declaration reaches both.
  There is no new API.
- Own-table class: the column is `NOT NULL`. Shared-table (STI) class: the
  column stays nullable, because sibling classes share it. On PostgreSQL smrt
  adds a `CHECK` that applies only to the classes that require the field. On
  SQLite and DuckDB the rule lives in the save-time check only.
- `smrt-dev-mcp` has a `harden-smrt-class` tool that writes this subclass for
  you. It edits app code and never touches a database.
- The class must be in a folder the smrt build scans, and the generated
  registration must load. A same-named class that the build does not register
  under its own name does not replace the smrt class.

What the subclass inherits:

- **A redeclared field keeps its parent's options.** You change only what you
  write. A bare `@field() override email` keeps every parent option.
- Your word wins per option, in either direction. Write `required: false`,
  `unique: false`, a lower `min` or a wider `max` to loosen.
- `null` clears an inherited option. Leaving an option out keeps it.
- If you change the field's type, the type-bound options are not inherited:
  `sqlType`, `min`, `max`, `enum`, `default`, `backfill`, `minLength`,
  `maxLength`, `pattern`. Others still are.
- Methods and every field you do not mention come from the parent unchanged.

The app owns its shape: it may tighten or loosen. The one refusal: **an app may
not loosen a field smrt needs for its own correctness**, which is a required
field that states `requiredFor`. The build stops with
`CONFIG_REQUIRED_FIELD_LOOSENED` and names the class and field. Keep the field
required, or leave it out of the subclass. A field without a reason is the
app's to loosen.

Details of the merge rule: [schema-paths.md](schema-paths.md#field-inheritance-one-rule-one-module-4922-4940-4942).
How collections pick the app's class: [object-runtime.md](object-runtime.md#same-named-subclass-replaces-its-parent-4921).
Run-time model definitions follow rule 2 too: [runtime-model.md](runtime-model.md).
