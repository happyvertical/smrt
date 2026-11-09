# Invoice source binding

`registerInvoiceSourceBinding('billable:@scope/package:Source', handler)` is a
trusted package-registration API. The handler validates that package's existing
reservation against the exact active tenant, invoice, line and canonical source.
It receives the bound database executor and a bind/release/validate phase. It
must fail closed for missing ownership, stale capacity or mismatched identities.
Client strings never invoke arbitrary model methods. A missing handler, including
an unavailable owning package, blocks protected source mutations/issue.

`bindInvoiceLineSource({db,tenantId,lineId,reservationId})` attaches an already
authorized owning reservation; it cannot manufacture source availability. The
owner must assign its reservation atomically with binding and enforce that one
reservation cannot identify two lines. `unbindInvoiceLineSource` requires the
owning handler to confirm release and a still-unissued draft. Keep both changes
in the same caller transaction so failure rolls them back together.

The nullable `sourceReservationId` is command-owned, guarded against both stored
and proposed source identities. A bound line cannot clear its pointer, switch
namespace/source, or be deleted through model/collection/invoice cascade paths.
Draft pricing may still change: source capacity and customer price are separate.
Issue validates every protected line; ordinary invoices with null pointers keep
their existing behavior. Issued money/source identity remains frozen through the
existing commerce snapshot machinery. Migrate this nullable column before use;
legacy protected lines without a valid reservation are refused at issue.

The owning `smrt-expenses` integration suite exercises real immutable reservations,
concurrent assignments, pointer/namespace/deletion/duplicate bypasses, withdrawal
and issued preservation against SQLite and the migrated PostgreSQL lane.
