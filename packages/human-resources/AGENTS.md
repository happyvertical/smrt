# smrt-human-resources

HR records: who works for an organization, as what, and with what standing
(#3435). It sits between identity (`smrt-profiles`) and pay (payroll, #3292):
payroll → human-resources → profiles. It holds no pay, no time records, no
logins or permissions, and no identity or contact details.

## Models

| Model | Table | Notes |
|---|---|---|
| `Employment` | `employments` | One per tenant and profile. `profileId`, optional `userId` and `employerProfileId`, `employeeNumber` (unique per tenant), `workerType`, `position`, `status` (`active` \| `on-leave` \| `ended`) |
| `EmploymentTerm` | `employment_terms` | One continuous period: `startedOn`, `endedOn` (last day, inclusive; null is open), `endReason`. A rehire adds a term |
| `EmploymentChange` | `employment_changes` | Append-only dated change: `kind`, `effectiveOn`, `fromValue`, `toValue`, `actorProfileId` |
| `Qualification` | `qualifications` | Definition, `key` unique per tenant: `kind`, `issuingBody`, `expires`, `validityMonths`, `scope` (`person` \| `employment`) |
| `HeldQualification` | `held_qualifications` | A person holds a qualification: `issuedOn`, `expiresOn`, `certificateNumber`, `status`, verifier, optional `documentAssetId`, `renewalOfId` |
| `HeldQualificationChange` | `held_qualification_changes` | Append-only dated change: `kind`, `effectiveOn`, `reason`, `actorProfileId` |

`EmploymentService` and `QualificationService` are the only writers (an
application subclass may save its own added fields; see "Extending
Employment"). Both are
constructed from a trusted `{ tenantId, profileId }` actor the application has
already authorized, and both take an optional `onEvent` hook. Construct them
with the root database handle, never one that is already inside a transaction
(see "Events need the root handle").

## Invariants

- **Sensitive and closed.** Every model is `@TenantScoped({ mode: 'required' })`,
  `sensitive: true`, with `api` / `mcp` / `cli` set to `{ include: [] }`.
  `save()` throws outside a service (`src/write.ts`) and `delete()` always
  throws. Services insert rows only through `insertHr()` in `src/write.ts`,
  which uses the model's public constructor, `initialize()` and
  `requireInsertOnSave()`; never reach into a collection's protected
  `createUnsaved()`. A subclass must restate the closed surface: `@smrt` exposure is not
  inherited, and an empty `@smrt()` exposes everything.
- **Collections are closed too.** Collection classes are registered like
  models, so each of the six carries
  `@smrt({ api: { include: [] }, mcp: { include: [] }, cli: false })` as an
  inline literal (the scanner cannot resolve an imported constant). An
  undecorated collection publishes its methods as MCP tools. A collection's
  config merges over its model's, so a model's effective `cli` reads `false`.
  `src/__tests__/closed-surface.test.ts` asserts no generated tool exists.
- **The tenant is the employer.** `employerProfileId` is informational and
  never part of uniqueness. There is one `Employment` per tenant and profile,
  so (tenant, profile, date) resolves to at most one employment.
- **The employment id is stable.** Rehire adds a term to the same row; other
  packages and applications key on `Employment.id`.
- **Dates are calendar dates.** `YYYY-MM-DD` text, compared as strings, with
  no timezone. The application converts an instant to its local date first.
  `verifiedAt` is the one instant.
- **"Employed on a date" comes from terms**, never from `status`. `on-leave`
  still counts as employed.
- **`ended` means an end has been recorded**, not "no longer employed today".
  `end` accepts an `endedOn` ahead of the day it is called (a notice period)
  and stores `ended` at once; the package has no clock and never flips a
  status when a date passes. For "on a date" use `check`, `employedOn`, `asOf`
  or `findByUser(userId, on)`.
- **Dated changes belong to the latest term.** `changePosition`,
  `changeWorkerType`, `placeOnLeave` and `returnFromLeave` are accepted when
  `effectiveOn` is inside the latest term: the open one, or after an end is
  recorded the final one up to and including its `endedOn`. On an ended
  employment the stored status stays `ended`, the row's `position` /
  `workerType` update as usual, leave is validated from the replayed history
  as of `effectiveOn` (not from `status`), and the usual event is raised. A
  date after the last day is `HR_STATUS_TRANSITION`; before the term started,
  `HR_INVALID`.
- **History is append-only.** Changes are new rows. A term is closed once. A
  renewal is a new `HeldQualification` pointing at the old one through
  `renewalOfId`. A row stored `revoked` is never saved again, except for its
  verification fields (`HeldQualification.save()` allows a save that changes
  only `verifiedByProfileId`, `verifiedAt` and `documentAssetId`); a later
  suspension, reinstatement or earlier revocation of one is a further change
  row, never an edit.
- **A stored qualification status is "the last change recorded", not
  standing, and no rule decides standing from it.** `revoke` and `suspend`
  store their status at once even when `effectiveOn` is ahead, and `reinstate` stores `valid`
  even when it takes effect later (`expired` if the sweep has recorded the
  row's lapse).
  The one sticky value is `revoked`: once stored it stays, whatever is
  recorded afterwards. Every rule decides from the dated history, as `check`
  does: the one-live-grant rule, renewal validation, `expiringWithin`, the
  employment-end cutoff, and the transitions themselves.
- **Transitions are validated by replay as of `effectiveOn`.** On the latest
  row of a chain, from the chain's whole history: `suspend` needs the chain
  neither suspended nor revoked on `effectiveOn`; `reinstate` needs it
  suspended (and not revoked) on `effectiveOn`; both are `HR_INVALID` when
  dated before the chain's latest suspension or reinstatement, so those two
  are recorded in date order. `revoke` is exempt from that ordering (it is
  terminal and the earliest one wins in replay) and is refused only when a
  revocation effective on or before `effectiveOn` is already recorded
  (`HR_STATUS_TRANSITION`). So a revocation recorded for a later date (a
  scheduled one, an employment end with a last day ahead, a grant against a
  closed term) freezes nothing: until it takes effect the qualification can
  be suspended, reinstated, renewed, or revoked from an earlier day. A stored
  `expired` blocks none of them.
- **A term holds its own changes.** `end` rejects an `endedOn` earlier than a
  position, worker-type or leave change recorded in the open term, and
  `rehire` a start before one, so replay (`check().onLeave`, `asOf`) never
  picks up a change dated outside its term. Login links are not replayed and
  are not part of this rule.
- **Login links are immediate.** `linkLogin` / `unlinkLogin` write the stored
  `userId` at once; `effectiveOn` is only recorded on the change row. `asOf`
  does not replay them and `findByUser(userId, on)` reads the stored `userId`
  (only the terms are dated).
- **A login is exclusive to the employment that stores it.** `hire`, `rehire`
  and `linkLogin` reject (`HR_INVALID`) a `userId` stored on any other
  employment in the tenant, whatever that employment's status: an ended
  employment keeps its login through its notice period and after, until
  `unlinkLogin` (which works on an ended employment) clears it. So two
  employments never share a login through the service, and neither lookup
  can be ambiguous; `findByUser` still fails closed on an ambiguous match as
  a backstop for rows written some other way. `findByUser(userId)` goes by
  the stored status; `findByUser(userId, on)` goes by terms covering `on`,
  whatever the status, and is what a host that records end dates ahead of
  time must call.
- **A renewal chain shares its standing.** `check`, `holders` and
  `listForProfile` treat a row as not good on a date when a later row in its
  chain is suspended or revoked on that date. `suspend`, `reinstate` and
  `revoke` act on the latest row only (`HR_INVALID` on a row that was
  renewed), and the change belongs to the chain: `effectiveOn` may be any
  date from the chain's first `issuedOn` onward (see "Transitions are
  validated by replay" for the ordering rule). It may precede the latest
  row's own `issuedOn`. That is how a ticket in force today is withdrawn
  after its renewal was recorded ahead of time: the earlier row stops passing from
  `effectiveOn`, and the renewal does not restore standing when its issue
  date arrives (revoked from issue, or suspended from issue until
  reinstated). `listForProfile` reports the status of the latest row issued
  by the date, so it agrees with `check` instead of answering
  `not-yet-issued`.
- **A renewal is validated by date.** `renew` rejects an `issuedOn` earlier
  than the row's own, or earlier than its latest suspension or reinstatement
  (`HR_INVALID`: the renewal would answer for dates the history says were
  suspended); a row suspended on `issuedOn` by replay
  (`HR_STATUS_TRANSITION`: reinstate first); a row revoked on or before
  `issuedOn` (`HR_INVALID`); an expiry earlier than the row's own, or any
  expiry on a renewal of a row that has none (`HR_INVALID`: the renewed row
  keeps answering for its own period, so a shorter renewal would lapse while
  `check` still passed; to replace a qualification with a shorter one,
  revoke it from that day and grant a new one); and a person who holds
  another chain that is not
  revoked on or before `issuedOn` and overlaps the renewal
  (`HR_ALREADY_HELD`). A chain that only starts on or after the day the
  renewal is cut off (its carried revocation) does not overlap, so a lapsed
  ticket can be renewed up to its scheduled revocation even when the next
  grant, dated from that day, was recorded first.
- **A renewal carries a pending cutoff forward.** A row whose revocation
  takes effect after `issuedOn` is still in force and is renewed normally;
  replay only propagates standing from later rows to earlier ones, so the
  renewal records the cutoff on itself: a `revoked` change at the earlier of
  the old row's pending revocation (with its reason) and, inside a closed
  employment term, `endedOn + 1` (`employment-ended`; it wins a tie). The
  renewal is stored `revoked` and raises `renewed` then `revoked`. Each
  remaining latest row therefore holds its chain's revocation, which
  `expiringWithin`, the one-live-grant rule and `renew` rely on.
- **One live grant, by date.** `grant` is refused (`HR_ALREADY_HELD`) unless
  every chain the person already holds of that qualification is revoked
  effective on or before the new `issuedOn`. A revocation recorded for a
  later date does not free an earlier issue date (the message says to renew
  the existing one), and a lapsed ticket, swept or not, is renewed instead of
  granted again.
- **Verification is not a status.** `verify` sets `verifiedByProfileId` and
  `verifiedAt` (and optionally the document) on any row, including one stored
  `revoked`; it writes no change row and raises no event.
- **Ids are validated.** A blank or missing id is `HR_INVALID` in both
  services (`HrService.id`); the `check` methods answer `not-employed` /
  `not-held` instead.
- **Qualification scope.** A `person`-scoped held qualification survives a
  change of employment. An `employment`-scoped one carries `employmentId` and
  is revoked, with reason `employment-ended`, in the transaction that ends the
  employment. The revocation is effective the day after `endedOn`, so the
  qualification is still good on the last day employed. The cutoff is the
  earliest one, decided by date and per renewal chain
  (`revokeEmploymentQualifications`): the latest row of each chain of the
  employment gets it, with one `held-qualification.revoked` event, unless a
  revocation effective on or before it is already recorded anywhere in the
  chain. Rows that were renewed are not written; replay cuts them off through
  the chain. A latest row already stored `revoked` for a later date gets the
  change row only and the event carries the earlier date; replay takes the
  earliest revocation. A grant or renewal dated inside a term whose end is
  already recorded (granted during notice, or backdated) gets the same
  revocation in its own transaction and is stored `revoked` from the start.
- **Expiry is computed.** A check on a date reads `expiresOn`; the stored
  `expired` status is written by `QualificationService.sweepExpired()`,
  which the application calls from its own scheduler (and by reinstating a
  row whose lapse the sweep has recorded); it is bookkeeping and
  no rule reads standing from it. The sweep decides which rows lapsed by
  date: every row whose last day is before `today`, that has no `expired`
  change yet and was not revoked on or before the day after `expiresOn`,
  gets an `expired` change and (unless it was renewed) the event. That
  includes a ticket that runs out while suspended, or while a revocation is
  recorded for a later day (a notice period). Only a row stored `valid` has
  its stored status set to `expired`; a stored `suspended` or `revoked`
  stays. Those rows are re-read on every run, so a scheduled sweep should
  pass `{ since }` (a day on or before the last day its previous run
  covered) to bound the work. `expiringWithin(days, today,
  { employedOnly })` lists rows that are good on `today` by the same dated
  evaluation as `check` (issued by `today`, not suspended or revoked on it,
  not renewed) and can keep only people employed on `today`.
- **Events need the root handle.** A mutation begins its own transaction
  with `db.beginTransaction()`, commits it, then delivers its events.
  `@happyvertical/sql` has no after-commit hook and no marker for "inside a
  transaction" (happyvertical/sdk#1249), so on a handle that is already
  inside one (the `tx` of `db.transaction()`, a savepoint scope, or a
  `beginTransaction()` handle) the commit would be the caller's and an outer
  rollback could follow a delivered event. `HrService.transact` therefore
  refuses a mutation on such a handle with `HR_TRANSACTION_UNSUPPORTED`
  before writing anything. It recognises one by asking it to begin: a
  transaction-scoped handle either has no `beginTransaction` (libsql SQLite,
  PostgreSQL, DuckDB, JSON) or exposes one that throws
  `NestedTransactionError` without touching the connection (the
  native-capabilities SQLite adapter, opened for `vector` /
  `notifications`). Never go back to `db.transaction()` /
  `withEmbeddedWriteTransaction` here: on a transaction-scoped handle those
  re-enter the caller's transaction under a savepoint, or with
  `reuseUnsupportedNested` run on the caller's handle, and both fail open.
  Reads work on any handle. Tests that isolate with
  `createIsolatedTestDb*()` must hand the services `baseDb`, not the
  transaction handle.
- **Tested on SQLite and PostgreSQL.** `HrService.identity` normalizes ids
  only on PostgreSQL. On any other adapter (DuckDB included) nothing is
  normalized, so callers must pass canonical lowercase UUIDs.
- **Not a permission system.** A qualification says what a person may do in
  the real world. Who may use the software stays with `smrt-users`.
- **People are `smrt-profiles:Profile` ids** in fields named `profileId` or
  `<role>ProfileId`, as cross-package refs. This is the id `smrt-timesheets`
  holds.

## Extending Employment

Declare a same-named subclass over the `employments` table in the application,
restating the fields and the closed surface, and add application fields there
(teamworks-os keeps succession rank and acting-role fields this way). Only one
inheritance family may share a table; the deepest same-named subclass wins.

`Employment.save()` lets such a subclass write its own fields: without the
service's write capability a save is allowed only for an existing row whose
package-owned columns (`tenantId`, `profileId`, `userId`, `employerProfileId`,
`employeeNumber`, `workerType`, `position`, `status`) all still hold their
stored values. A save that changes one of them, and any insert, throws
`HR_WRITE_FORBIDDEN`; `delete()` always throws. Add a column to
`PACKAGE_OWNED_COLUMNS` in `src/employment/models.ts` when the package gains
one.

## Svelte UI

`@happyvertical/smrt-human-resources/svelte` ships four components, each
registered as a slot in `HUMAN_RESOURCES_UI_SLOTS` (`src/ui.ts`):

| Component | Slot | Shows |
|---|---|---|
| `EmployeeList` | `employee-list` | Name, employee number, position, worker type, status (plus "Last day {date}" when `endsOn` is set), start date |
| `EmployeeForm` | `employee-form` | Employee number, worker type, position, start date (new hire only), effective date (edit only), optional login |
| `PersonQualifications` | `person-qualifications` | One person's qualifications with their expiry state |
| `ExpiringQualificationsList` | `expiring-qualifications-list` | Qualifications expiring soon across people, soonest first |

- **Props-driven.** Components never load or save. The host calls the
  services, adapts rows with the helpers in `src/svelte/types.ts`
  (`toEmployeeView`, `toPersonQualificationView`,
  `toExpiringQualificationView`) and handles `onselect` / `onsubmit`.
- **No clock in components.** `EmployeeList` shows the stored status badge
  and, when the host passes `endsOn` (the latest term's `endedOn`, fourth
  argument of `toEmployeeView`), the text "Last day {date}". It never compares
  a date with today to decide a label.
- **Names come from the host.** HR holds no identity data, so every view
  carries a `displayName` the host supplies.
- **`EmployeeForm` is hand-built** from smrt-ui form primitives (owner
  decision); the package does not depend on `smrt-fields` or `smrt-users`.
- **`EmployeeForm` values are not a service input.** A hire returns
  `startedOn`; an edit returns a required `effectiveOn` (prefilled from
  `today`) that the host passes to `changePosition` / `changeWorkerType` /
  `linkLogin` / `unlinkLogin` for each value that changed. A login link or
  unlink takes effect at once whatever the date, so a future-dated edit that
  also clears the login unlinks it immediately; a host that wants it kept
  until then calls `unlinkLogin` on that day. The employee's
  current login stays an option even when the host's `logins` omit it, so a
  save never unlinks it by accident. Each validation message is tied to its
  field with `aria-describedby`.
- **Day arithmetic is UTC** (`daysUntil`); never build a local-time `Date`
  from a calendar date.
- **Expiry state is text plus a badge**, never colour alone. "Expiring soon"
  is a valid qualification whose last day is within `expiringSoonDays`
  (default 30), inclusive.
- **Strings** go through `useI18n()` and the catalog in `src/svelte/i18n.ts`,
  keyed `human_resources.<component>.<key>`. Only smrt-ui primitives; no raw
  `<input>` / `<button>` / `<select>`.

## Validation commands

```bash
pnpm --filter @happyvertical/smrt-human-resources build
pnpm --filter @happyvertical/smrt-human-resources test
pnpm --filter @happyvertical/smrt-human-resources typecheck
```

Build before `test`: `src/__tests__/employment-extension.test.ts` reads
`dist/manifest.json`.
