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
already authorized, and both take an optional `onEvent` hook.

## Invariants

- **Sensitive and closed.** Every model is `@TenantScoped({ mode: 'required' })`,
  `sensitive: true`, with `api` / `mcp` / `cli` set to `{ include: [] }`.
  `save()` throws outside a service (`src/write.ts`) and `delete()` always
  throws. A subclass must restate the closed surface: `@smrt` exposure is not
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
  `renewalOfId`. A revoked qualification never changes.
- **A term holds its own changes.** `end` rejects an `endedOn` earlier than a
  position, worker-type or leave change recorded in the open term, and
  `rehire` a start before one, so replay (`check().onLeave`, `asOf`) never
  picks up a change dated outside its term. Login links are not replayed and
  are not part of this rule.
- **One live employment per login.** `hire`, `rehire` and `linkLogin` reject a `userId`
  already linked to another employment whose stored status is not `ended` in
  the tenant; `findByUser` still fails closed on an ambiguous match as a
  backstop. `findByUser(userId)` goes by the stored status;
  `findByUser(userId, on)` goes by terms covering `on`, whatever the status,
  and is what a host that records end dates ahead of time must call. A login
  can be linked to a second employment while the first is on notice, so both
  may cover a date: the dated lookup then returns null.
- **A renewal chain shares its standing.** `check`, `holders` and
  `listForProfile` treat a row as not good on a date when a later row in its
  chain is suspended or revoked on that date. `suspend`, `reinstate` and
  `revoke` act on the latest row only (`HR_INVALID` on a row that was
  renewed). `renew` rejects a suspended row (`HR_STATUS_TRANSITION`: reinstate
  first, or the renewal would lift the suspension) and a row whose person
  holds another live row outside the chain (`HR_ALREADY_HELD`).
- **Verification is not a status.** `verify` sets `verifiedByProfileId` and
  `verifiedAt` (and optionally the document) on a row that is not revoked; it
  writes no change row and raises no event.
- **Ids are validated.** A blank or missing id is `HR_INVALID` in both
  services (`HrService.id`); the `check` methods answer `not-employed` /
  `not-held` instead.
- **Qualification scope.** A `person`-scoped held qualification survives a
  change of employment. An `employment`-scoped one carries `employmentId` and
  is revoked, with reason `employment-ended`, in the transaction that ends the
  employment. The revocation is effective the day after `endedOn`, so the
  qualification is still good on the last day employed.
- **Expiry is computed.** A check on a date reads `expiresOn`; the stored
  `expired` status is written only by `QualificationService.sweepExpired()`,
  which the application calls from its own scheduler. `grant` goes by the
  stored status, so a lapsed row nobody swept is renewed, not granted again.
  `expiringWithin(days, today, { employedOnly })` can keep only people
  employed on `today`.
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
  `linkLogin` / `unlinkLogin` for each value that changed. The employee's
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
