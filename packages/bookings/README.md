# s-m-r-t Bookings

`@happyvertical/smrt-bookings` reserves one elapsed developer hour or one
operator-declared local supervision window. It does not start agents, collect
payment, send notifications, or write Commerce records.

Apply `migrateBookingsV1` once through the host's deployment migration ledger
using a PostgreSQL database handle. Use an ordinary PostgreSQL connection or
pool for `BookingService`; the service owns its transaction and explicitly uses
READ COMMITTED. It does not create schema on demand. No ORM collection, CRUD
route, or generated CLI or MCP write is registered.

1. An operator enables an offering and declares availability for a canonical
   provider UUID. Use the same provider identity for all services that reserve
   the same person. A declaration replaces that provider's configured windows.
   Windows must not overlap and must have positive integer capacity. Mark at
   most one exact supervision window per provider per local date. Changes that
   invalidate any active reservation are refused.
2. The named customer contact, or an operator acting for them, requests an
   enabled offering. A supervision request requires a project. Disabling an
   offering stops new requests; operators may finish pending requests.
3. An operator proposes a provider, window, and terms revision with the exact
   agreed wording. Supervision also needs an approved project plan ID and
   version. Each proposal is immutable. The contact assents to its exact ID.
   Replacing the proposal clears current assent. Requests, proposals, and
   assent reserve no capacity.
4. An operator confirms the exact assented proposal. The service locks the
   booking and then the stable provider row, checks authority and current
   declared availability, and checks every half-open segment. An exclusive
   hour blocks all overlaps; supervision consumes one unit. Two active
   supervision reservations for the same project and exact UTC interval are
   refused even on different providers. An unsuccessful confirmation leaves
   the proposal and assent available for a retry or revision.
5. An operator can decline a pending request or cancel a pending or confirmed
   booking with a reason. Cancelling a confirmed booking releases capacity
   in the same transaction; it preserves the confirmed terms and history.
   Booking and historical proposal reads are scoped to the named contact or
   an operator. Booking audit history is operator-only.

Windows use an IANA zone and local timestamps of the form
`2027-11-07T01:30-04:00`. For example, use that offset with America/New_York. The offset must be valid for that instant in the zone.
During a DST fold the offsets identify different instants; a nonexistent wall
time is rejected. Stored proposals retain the local input and UTC instants.
Intervals include their start and exclude their end. A supervision window
starts and ends on one local date, or ends at midnight opening the next date;
it need not cover the entire day and may span a daylight-saving transition.

Use `listBookings` to find the same booking views returned by `get`. An
optional project UUID narrows the results within the caller's existing scope.
Operators see all bookings in their tenant. Other callers see only bookings
for the contact the host maps to their actor. `listOfferings` exposes the
offering ID, kind and enabled flag. Contacts only see enabled offerings.
Operators can use `listAvailability` to inspect existing provider windows
before replacing a declaration. All three methods use the `read` authority.

Lists return up to 50 items by default and accept a limit from 1 to 100.
Results are ordered by ascending UUID. Pass the returned `nextCursor` as
`afterId` with the same filters to fetch another page. A null cursor means
the page reached the end of the results.

Use an authenticated tenant/actor context from the host, never from a request
body. The host's `BookingAuthority` supplies current operator permission and
the actor's named contact mapping, and must verify that external references
exist in that tenant and relate to each other. For a supervision proposal and
again at confirmation, it must verify that the exact plan version is approved
for the project. The confirmation check occurs after the provider lock; it is
evidence of approval at that point, not a distributed lock on a plan system.
Authority callbacks should be read-only and must not call a booking command.

Each write takes a retry key scoped to tenant and operation. A committed key
is bound to its actor and normalized command payload. An identical authorized
retry returns the original receipt; a different payload or actor is rejected.
A failed command rolls back both its changes and the key claim. Command receipts
and audit history commit with the booking, so a failure in caller-owned
communication does not undo the reservation. Clients can fetch it afterward
and coordinate manual invoicing separately.

Only real PostgreSQL is supported for writes. To run the package unit tests,
use `pnpm --filter @happyvertical/smrt-bookings test`. To run the separate
PostgreSQL suite, point `CI_POSTGRES_BASE_URL` at an isolated server with
database creation privileges and run `pnpm --filter @happyvertical/smrt-bookings
test:postgres`. The test wrapper provisions and removes a disposable database.
