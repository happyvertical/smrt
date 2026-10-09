# @happyvertical/smrt-comments

Tenant-scoped polymorphic record comments, mention notification composition,
and a browser-safe `RecordComments` Svelte component.

Use `CommentService` on the server with a trusted `{ tenantId, userId }` actor
from the authenticated session and an `authorizeRecord` callback. The callback
must verify that the record belongs to that tenant and that the actor may read
or comment on it. Both `create` and `listForRecord` require that decision; request
bodies cannot override the actor. Direct model/collection APIs are persistence
primitives for trusted code, not authorization boundaries. Generated API, MCP,
and CLI access is disabled.

```ts
const comments = new CommentService({
  db,
  actor: { tenantId: session.tenantId, userId: session.userId },
  authorizeRecord: access => records.authorize(access),
  mentionNotifications: createCommentMentionNotifications({
    notifications: new UserNotificationService({ db }), // smrt-messages
    canNotify: mention => records.recipientMayRead(mention),
  }),
});
```

The messages service is composed through a structural interface; there is no
runtime dependency on messages. `canNotify` must check recipient membership and
record access before exposing the comment. Notifications use a stable per-comment
source reference so adapter replays deduplicate. Mentions are UUIDs, deduplicated,
and limited to 50; self-mentions do not notify. No adapter means no notifications.
The comment is saved before notification delivery. A delivery rejection leaves
the comment saved: reload it and retry delivery, not `create`, which creates a
new comment. Delivery and persistence are deliberately not one transaction.

Import `RecordComments` from `@happyvertical/smrt-comments/svelte`. Pass authorized
comment projections, an `onsubmit(body)` callback, and a `contextKey` containing
the current tenant, actor and record identity. Change that key whenever any of
those identities changes: it clears drafts/errors and ignores stale submission
completion. The host owns loading, authentication, mention selection and refresh.
The component renders plain text. `RecordCommentsRecipe` declares the
`comments.records` model recipe; surface/provider declarations await the shared
recipe contract.

Validation: `pnpm --filter @happyvertical/smrt-comments test` covers SQLite and
DuckDB. `pnpm --filter @happyvertical/smrt-comments test:postgres` adds PostgreSQL
using the repository's disposable-database wrapper and ordinary CI role.
