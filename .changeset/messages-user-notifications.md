---
'@happyvertical/smrt-messages': minor
---

Per-user in-app notifications. **New table `user_notifications`: run
`smrt db:migrate`.** `UserNotification` stores one notification per recipient
(tenant, `recipientUserId` → smrt-users User, kind, title, body, href,
severity, `sourceRef`, `occurredAt`, `readAt`, `dismissedAt`), keyed by
`(tenant_id, recipient_user_id, source_ref)`. `UserNotificationService` is the
access path: `notify` / `notifyMany` dedupe on `sourceRef` without touching read
state (a notify that loses the dedupe race returns the stored row untouched,
`created: false`), `listForUser` / `countUnread` read one recipient across
explicit tenants, and `markRead` / `dismiss` / `markAllRead` change only the
recipient's own rows (malformed ids are dropped instead of failing the request
with 22P02). Generated REST/MCP/CLI surfaces are off.
