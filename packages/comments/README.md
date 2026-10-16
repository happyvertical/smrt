# @happyvertical/smrt-comments

Tenant-scoped polymorphic record comments, mention notification composition,
and a browser-safe `RecordComments` Svelte component.

Use `CommentService` on the server with a trusted `{ tenantId, userId }` actor
from the authenticated session and an `authorizeRecord` callback. The callback
must verify that the record belongs to that tenant and that the actor may read
or comment on it. Both `create` and `listForRecord` require that decision; request
bodies cannot override the actor. `CreateCommentInput` contains only tenant,
author, record type/id, body, mentions and an optional `idempotencyKey`. The service ignores extra runtime
properties, generates its own UUID/slug and inserts a new row without natural-key
adoption. Caller-provided identity, context, database and constructor options
never reach persistence. `CommentOptions` remains the separate trusted model
hydration type. Direct model/collection APIs are persistence
primitives for trusted code, not authorization boundaries. Generated API, MCP,
and CLI access is disabled.

```ts
const comments = new CommentService({
  db,
  actor: { tenantId: session.tenantId, userId: session.userId },
  authorizeRecord: access => records.authorize(access),
  participation: {
    // Supplies trusted membership and entitlement facts.
    authorize: request => entitlements.authorize(request),
  },
  mentionNotifications: createCommentMentionNotifications({
    notifications: new UserNotificationService({ db }), // smrt-messages
    canNotify: mention => records.recipientMayRead(mention),
  }),
});
```

`participation` is an optional server-side entitlement adapter. It receives trusted
identity and record/action inputs and returns `{ allowed, member?, snapshot? }`.
Only literal `allowed: true` permits participation; `members_only` also requires
`member: true`. The immutable JSON snapshot is retained on each new comment.

`ParticipationService` owns reusable tenant/target policy selection, bans and
atomic fixed-window rate reservations. All CommentService creates invoke it,
even without an entitlement adapter. Configure `ParticipationPolicyCollection`
and `ParticipationBanCollection` on trusted administrative server paths under
`withTenant`; these models expose no automatic API/CLI/MCP operations. Migrate
all comments package models before deploying. A missing policy defaults to open;
an exact `(recordType, recordId, action)` policy replaces the tenant default
(blank record pair). Modes are `open`, `pre_moderated`, `members_only`, `closed`.
A duplicate applicable policy fails closed. Ban targets may be blank (tenant-wide)
or exact; a null expiry means indefinite. Ban decisions do not expose reasons.

`maxActions: 0` disables quota; otherwise set a positive integer `windowSeconds`.
Quota is per tenant, actor, action and selected policy scope in fixed UTC epoch
windows. A tenant policy shares quota across records. The persisted counter uses
one bounded atomic upsert; reservation and protected mutation commit or roll back
together. Never delete active rate buckets. Policy edits affect subsequent
checks, not transactions already authorized; changing a window length starts a
new quota namespace. Trusted administrators own policy and bucket retention.

Reactions/polls import `ParticipationService` and neutral types from
`@happyvertical/smrt-comments/participation`. Use `execute(request, (tx, decision)
=> mutationUsing(tx))` for a new mutation. Within an existing transaction use
`executeInTransaction(tx, request, callback)` and propagate errors so the owner
rolls back. `authorize` checks current permission without spending quota. The
consumer owns its durable idempotency binding: replay retained mutations after
reauthorization, and call `execute` only for a genuinely new mutation. Comments
already implement this composition. No subscription or journalism rules live here.

`CommentService.edit` retains prior bodies and rechecks record/participation permission,
bans and the comment-action quota in the same transaction. Edits spend quota and
retain the original post-time snapshot. `report` appends a moderation report,
and `moderate` checks the host's record-level moderation permission before changing
visibility. Readers receive authorized projections; hosts filter non-visible rows
for their audience. `ModerationQueue` accepts pending/reported projections and an
`onmoderate` callback; the browser cannot grant moderation authority.

The messages service is composed through a structural interface; there is no
runtime dependency on messages. `canNotify` must check recipient membership and
record access before exposing the comment. Notifications use a stable per-comment
source reference so adapter replays deduplicate. Mentions are UUIDs, deduplicated,
and limited to 50; self-mentions do not notify. No adapter means no notifications.
Mention validation finishes before the single comment insert; invalid or over-limit
mentions leave no saved row. The comment is saved before notification delivery. A delivery rejection leaves
the comment saved. With `idempotencyKey`, retry `create` with the same key and
content to recover delivery without creating another comment. Without a key,
reload and retry delivery rather than creating another comment. The component warns users to refresh and check the discussion before
posting again when submission rejects. Delivery and persistence are separate unless the host composes both with the same
outer transaction. See [idempotent creation](agents/idempotent-create.md) for key
binding, typed conflicts, retention and transaction requirements.

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

Keyed retries use a separate canonical tenant binding while preserving stored
tenant and author references. UUID casing changes across trusted actor contexts
reuse the same comment, including after generic receipt retention. Unkeyed legacy SQLite
listing remains scoped to its original tenant spelling; keyed rows are merged
by equivalent UUID tenant without folding arbitrary textual tenant IDs.

Use lowercase UUIDs for administrative policy/ban tenant, actor and target identities;
request UUIDs are canonicalized before enforcement. Text identifiers retain case.
Thread projections may include `parentCommentId`; supply `onreply(parentId, body)`
to enable the reply composer. Host callbacks persist replies with that parent ID.

Edits to visible comments return to pending when current policy or entitlement
requires pre-moderation; edits never restore hidden or deleted comments.

Reports use the separate `report` participation action, so hosts can configure
report-specific limits without coupling them to comment quotas. Bans and entitlement
checks apply to every report attempt. Only visible comments are reportable. Each
actor/comment pair retains one report, including after generic receipt cleanup;
retries return that report without consuming quota or replacing its original reason.

Parentless keyed-create digests preserve the original v1 shape across upgrades.
After an authorized edit, replay verifies the original creation body against retained
revision history and returns the current comment; edited content is not a new create
payload. Revision history must be retained while the keyed comment is retained.

Mention delivery is limited to visible comments, including keyed retries. Pending,
hidden and deleted bodies never reach the mention adapter. Approval does not
send notifications automatically; hosts may explicitly retry the original keyed
create after approval to recover delivery. Moderation uses the save lifecycle on
a locked and freshly reloaded row, preserving change-feed and cache invalidation.
Parent comment UUIDs are canonicalized before lookup, persistence and retry hashing.
Reply-only embeds show a composer only while a reply target is selected.
