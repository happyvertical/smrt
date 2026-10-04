# @happyvertical/smrt-human-resources

HR records for s-m-r-t: who works for an organization, as what, and
with what standing.

- **Employment**: one record per tenant and person, with an employee number,
  worker type, position, status, dated terms and an append-only change history.
- **Qualifications**: a managed list of definitions (tickets, certifications,
  authorizations, training, restrictions) and what each person holds, with
  issue and expiry dates.

Pay belongs to payroll, time records to `smrt-timesheets`, logins and
permissions to `smrt-users`, and identity to `smrt-profiles`.

## Install

```bash
pnpm add @happyvertical/smrt-human-resources
```

## Access

Every model is tenant-scoped (required), sensitive, and publishes no generated
REST, MCP or CLI operation; the collection classes are closed the same way.
All writes go through `EmploymentService` and
`QualificationService`. The application authorizes the acting person first,
then constructs a service from that trusted actor:

```typescript
const actor = { tenantId, profileId: managerProfileId };
```

`profileId` is a `smrt-profiles` Profile id and is recorded on every change.
Models reject `save()` and `delete()` outside the services (an application
subclass of `Employment` may save its own fields; see below).

## Dates

Dates are calendar dates written `YYYY-MM-DD`, with no timezone. Convert an
instant to your local date before asking "on what day". An employment term's
`endedOn` is the last day employed, inclusive.

## Employment

```typescript
import { EmploymentService } from '@happyvertical/smrt-human-resources';

const hr = new EmploymentService(
  db,
  { tenantId, profileId: managerProfileId },
  { onEvent: (event) => void notified.push(event.type) },
);

const employment = await hr.hire({
  profileId: workerProfileId,
  employeeNumber: 'E-1042',
  startedOn: '2026-01-05',
  position: 'Welder',
});

const check = await hr.check(workerProfileId, '2026-02-01');
// { ok: true, employmentId: employment.id, onLeave: false }

await hr.end(employment.id as string, {
  endedOn: '2026-03-31', // last day employed, inclusive
  reason: 'Season over',
});
const after = await hr.check(workerProfileId, '2026-04-01');
// { ok: false, reason: 'ended' }

const rehired = await hr.rehire(employment.id as string, {
  startedOn: '2026-06-01',
});
// rehired.id === employment.id; hr.terms(rehired.id) has two terms
```

- An end may be recorded ahead of the last day (a notice period). The stored
  status becomes `ended` at once and means "an end has been recorded", not
  "no longer employed today": the person is employed up to and including
  `endedOn`. Ask "on a date" with `check(profileId, on)`, `employedOn(on)`,
  `asOf(employmentId, on)` or `findByUser(userId, on)`. The package has no
  clock and never flips a status when a date passes.
- There is one employment per tenant and profile. A rehire adds a term to the
  same record, so its id is stable for anything that references it.
- `check(profileId, on)` and `employedOn(on)` answer from the dated terms, not
  from the stored status. Someone on leave is still employed; `check` reports
  `onLeave`.
- `changePosition`, `changeWorkerType`, `placeOnLeave` and `returnFromLeave`
  are dated changes; `history()` returns them and `asOf(employmentId, on)`
  replays them for a past date.
- `linkLogin` and `unlinkLogin` are recorded in `history()` with their
  `effectiveOn`, but they are not replayed and not scheduled: the login is
  linked or cleared as soon as the call is made, whatever the date says, and
  `findByUser(userId, on)` reads the login stored now. To unlink on a future
  day, call `unlinkLogin` on that day.
- Position, worker-type and leave changes are accepted inside the latest
  term. After an end is recorded that is the final term, up to and including
  its `endedOn`: the change is recorded and raises its usual event, the stored
  status stays `ended`, and leave is validated against the replayed history
  (`check().onLeave` and `asOf` answer it). A date after the last day is
  rejected with `HR_STATUS_TRANSITION` (rehire first); a date before the term
  started with `HR_INVALID`.
- A term holds its own changes: `end` rejects an `endedOn` earlier than a
  position, worker-type or leave change already recorded in the term, and
  `rehire` rejects a start before one.
- The login link (`userId`) is optional, and a login belongs to one
  employment at a time. It stays with that employment, ended or not, until
  `unlinkLogin` clears it there: `hire`, `rehire` and `linkLogin` reject
  (`HR_INVALID`) a login stored on any other employment, so a worker on
  notice keeps their login and nobody else can take it. To move a login,
  unlink it first (`unlinkLogin` works on an ended employment).
  `findByUser(userId)` returns only an employment whose
  stored status is not `ended`, so it stops resolving as soon as an end is
  recorded. `findByUser(userId, on)` answers from the terms instead: the
  linked employment with a term covering `on`, whatever its status. A host
  that records end dates ahead of time should pass the date, or a worker on
  notice is locked out.

## Qualifications

```typescript
import { QualificationService } from '@happyvertical/smrt-human-resources';

const qualifications = new QualificationService(db, actor, {
  onEvent: (event) => void events.push(event), // after commit; a throwing handler never rolls back
});
const firstAidTicket = await qualifications.define({
  key: 'first-aid',
  name: 'First aid',
  kind: 'certification',
  expires: true,
  validityMonths: 36,
});
const held = await qualifications.grant({
  qualificationId: firstAidTicket.id as string,
  profileId: workerProfileId,
  issuedOn: '2026-03-01', // expiresOn defaults to 2029-03-01
  certificateNumber: 'FA-20931',
  verified: true,
});
const gate = await qualifications.check(
  workerProfileId,
  firstAidTicket.id as string,
  '2029-03-02',
); // { ok: false, reason: 'expired' }
const renewal = await qualifications.renew(held.id as string, {
  issuedOn: '2029-02-15',
}); // a new row; `held` still answers for 2026-03-01..2029-03-01
const after = await qualifications.check(
  workerProfileId,
  firstAidTicket.id as string,
  '2029-03-02',
); // { ok: true, heldQualificationId: renewal.id, expiresOn: '2032-02-15' }
```

- `check()` is the gate an application calls before allowing work. When it
  fails it says why: `not-held`, `not-yet-issued`, `expired`, `suspended` or
  `revoked`.
- Expiry is computed from the dates, so a check needs no sweep.
- Standing is decided by date everywhere. `suspend`, `reinstate` and `revoke`
  take an `effectiveOn` that may be ahead; the stored `status` changes at
  once and only says what was last recorded. `check`, `holders`,
  `listForProfile` and `expiringWithin` all answer from the dated history,
  and so do the rules for the next change: `suspend` needs the qualification
  to be neither suspended nor revoked on `effectiveOn`, `reinstate` needs it
  suspended on that day, and neither may be dated before the latest
  suspension or reinstatement.
- `revoke` is accepted for any date from the first issue date unless the
  qualification is already revoked on or before it. A revocation recorded for
  a later date (scheduled, or the end of an employment whose last day is
  ahead) freezes nothing: until it takes effect the qualification can still
  be suspended, reinstated, renewed, or revoked from an earlier day, and the
  earliest revocation is the one in force. A stored `revoked` is final, so
  those later changes are history rows only and the status keeps reading
  `revoked`.
- A person has one live grant of a qualification at a time. `grant` is
  refused (`HR_ALREADY_HELD`) unless everything they already hold of it is
  revoked effective on or before the new `issuedOn`: a revocation scheduled
  for 2027 does not allow a fresh grant dated 2026 (renew the existing one
  instead), and a lapsed ticket is renewed, not granted again.
- A definition's `scope` says who a held qualification belongs to. A `person`
  qualification survives a change of employment. An `employment` one is
  revoked, with reason `employment-ended`, when that employment ends: it is
  still good on the last day employed and revoked from the day after. That
  cutoff always wins: it also applies to a qualification whose own revocation
  was scheduled for a later date, and to one granted or renewed after the end
  was recorded (during notice, or backdated), which is stored `revoked` at
  once and passes `check` only through the last day employed. The end is
  decided per renewal chain: the latest row gets one revocation and one
  `held-qualification.revoked` event, the rows it renewed are cut off through
  the chain, and a chain already revoked on or before the cutoff gets nothing.
- A renewal is a new row, and the chain shares its standing. Suspend, reinstate
  or revoke the latest row: while it is suspended or revoked, the rows it
  renewed do not pass `check` either, and acting on a row that was already
  renewed is rejected (`HR_INVALID`). The change may take effect on any date
  from the chain's first issue date, so a ticket in force today can still be
  suspended or revoked after its renewal was recorded ahead of time: act on
  the renewal with today's date, and the renewal does not restore standing
  when its own issue date arrives.
- A renewal cannot be issued before the latest suspension or reinstatement
  of the row it renews (`HR_INVALID`), nor while that row is suspended on the
  issue date (`HR_STATUS_TRANSITION`: reinstate it first), nor when the row
  is revoked on or before the issue date (`HR_INVALID`; grant a new one dated
  on or after the revocation). A row whose revocation takes effect later is
  still in force and can be renewed, so a ticket that lapses during a notice
  period is not stuck: the renewal carries the cutoff forward (the pending
  revocation, or the day after the last day employed if that is earlier), is
  stored `revoked`, and raises `held-qualification.renewed` and `.revoked`.
- `verify(heldQualificationId, { documentAssetId })` records the actor as
  having verified the document, now, and optionally attaches or replaces it.
  It changes no status and works whatever the standing, including on a row
  stored `revoked`.
- `holders(qualificationId, on, { employedOnly: true })` lists, for example,
  the first aiders currently employed. `expiringWithin(days, today)` lists
  what is about to lapse: qualifications that pass `check` on `today` (issued,
  not suspended or revoked on that day, not already renewed) and whose last
  day is within the window; `{ employedOnly: true }` keeps only people
  employed on `today`.
- A blank id is rejected with `HR_INVALID`; `check` answers `not-held`.
- `seed(SUGGESTED_QUALIFICATIONS)` creates a few common definitions; it never
  changes ones that already exist.
- A qualification is not a permission. Who may use the software stays with
  `smrt-users`; an application may require both.

## Events and expiry

Both services take an `onEvent` hook, called after the change commits:
`employment.hired`, `.ended`, `.rehired`, `.position-changed`,
`.worker-type-changed`, `.leave-started`, `.leave-ended`, and
`held-qualification.granted`, `.renewed`, `.suspended`, `.reinstated`,
`.revoked`, `.expired`. Delivery is best-effort; bridge it to your own event
bus if you need more.

Construct the services with your root database handle. Each mutation begins
its own transaction (`beginTransaction()`), commits it, and then delivers its
events. A service built on a handle that is already inside a transaction (the
`tx` passed to `db.transaction()`, a savepoint scope, or a
`beginTransaction()` handle) could only deliver before the outer commit, so
it refuses every mutation with `HR_TRANSACTION_UNSUPPORTED` and writes
nothing; reads still work. Such a handle either has no `beginTransaction` or
refuses it with the SDK's `NestedTransactionError` (the native-capabilities
SQLite adapter, used for `vector` / `notifications`); the services never open
a nested transaction. An HR mutation therefore cannot be made atomic with
other work in a caller's transaction.

The package is tested on SQLite and PostgreSQL. Ids are normalized (to
canonical lowercase UUIDs) only on PostgreSQL; on any other adapter, DuckDB
included, pass canonical lowercase UUIDs yourself.

Nothing in the package runs on a schedule. Call
`qualifications.sweepExpired(today)` from your own scheduler to record lapsed
qualifications and receive `held-qualification.expired`. It decides by date,
so a ticket that runs out while suspended, or during a notice period, is
recorded too. Reminders are the application's business.

## Extending Employment

Add application fields with a same-named subclass over the `employments`
table. Restate the closed surface on the subclass: exposure is not inherited.
Read your subclass through your own collection and `save()` your own fields on
a row the service created. The columns this package owns (`tenantId`,
`profileId`, `userId`, `employerProfileId`, `employeeNumber`, `workerType`,
`position`, `status`) still change only through `EmploymentService`: a save
that changes one of them, or that would insert a row, throws
`HR_WRITE_FORBIDDEN`.

## Svelte components

`@happyvertical/smrt-human-resources/svelte` exports props-driven components:
an employee list, an employee form, a person's qualifications with their
expiry state, and an expiring-soon list. The host loads records through the
services and passes plain view objects.

`EmployeeList` shows the stored status. Pass the latest term's `endedOn` as
`endsOn` (the fourth argument of `toEmployeeView`) and the row also reads
"Last day 2026-12-31", so a worker on notice is not mistaken for one who has
left. The component never compares the date with today.

`EmployeeForm` never saves. For a new hire it returns `startedOn`; for an edit
it returns a required `effectiveOn` (prefilled from the `today` prop), which
the host passes to `changePosition`, `changeWorkerType`, `linkLogin` or
`unlinkLogin` for each value that changed. Position and worker-type changes
take effect on that date; a login link or unlink takes effect at once, so a
future-dated edit that also clears the login unlinks it immediately. A host
that wants the login kept until the date should hold the unlink back and
call `unlinkLogin` on that day.
