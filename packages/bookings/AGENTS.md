# SMRT Bookings

This package owns service reservations and capacity. Application hosts supply
trusted actor and tenant context and verify their own customer, provider, project
and plan relationships. Commerce and payment state are separate.

Use service commands for writes; keep this package out of generated CRUD. Apply
its explicit PostgreSQL migration during deployment, outside request handling.
See [README.md](README.md) for the transaction and verification contracts.

V2 is additive: a proposal's `windows` array is the reservation and the
allocation stores only its span.
