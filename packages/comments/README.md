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
Mention validation finishes before the single comment insert; invalid or over-limit
mentions leave no saved row. The comment is saved before notification delivery. A delivery rejection leaves
the comment saved: reload it and retry delivery, not `create`, which creates a
new comment. The component warns users to refresh and check the discussion before
posting again when submission rejects. Delivery and persistence are deliberately not one transaction.

Import `RecordComments` from `@happyvertical/smrt-comments/svelte`. Pass authorized
comment projections, an `onsubmit(body)` callback, and a `contextKey` containing
the current tenant, actor and record identity. Change that key whenever any of
those identities changes: it clears drafts/errors and ignores stale submission
completion. The host owns loading, authentication, mention selection and refresh.
The component renders plain text. `RecordCommentsRecipe` declares the
`comments.records` model recipe in the stable `comments` catalog group. It
intentionally has no global navigation or section: a discussion needs an
already-authorized parent record, and a generic comment list would lose that
context. Hosts embed it on a record detail page. Catalog help explains posting
and mentions without promising a mention picker or delivery configuration.
The recipe declares `runtime: both`: the record component runs in the browser,
while persistence and authorization run on the server. Its playground surface
exports `RecordCommentsPlayground`, a standalone sample-record preview with
local-only posting. `recordCommentsDemo` supplies the same sample projections
through `demoSeed`; remounting resets the preview. No notifications are sent.
There is no route, settings panel or shell widget: none can supply the authorized
parent-record context. No provider is declared because the host's record access
and mention policies are callbacks, not a selectable external provider.

Validation: `pnpm --filter @happyvertical/smrt-comments test` covers SQLite and
DuckDB. `pnpm --filter @happyvertical/smrt-comments test:postgres` adds PostgreSQL
using the repository's disposable-database wrapper and ordinary CI role.
