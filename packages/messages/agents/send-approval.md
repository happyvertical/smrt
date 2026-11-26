# Agent send policy, held sends, drafts and "handled by" (#5141)

Epic I (happyvertical.com#585). Code: `src/send-approval.ts`,
`src/mail-drafts.ts`, the send path in `src/models/Message.ts`.

## Who is an agent

The host supplies the acting principal through `configureMailAccess`'s
`resolvePrincipal`. Only `kind: 'person'` (or `'human'`) is a person;
anything else, including no label, is an agent. A persona route
(`message.personaId`, `PersonaMessagingService`) is an agent send whoever
invoked it (requester `persona:<id>`). Trusted system work
(`runWithMailSystemAccess`: sync, the outbox) is never held. With no
principal: when a gate is configured, a persona send is held and any other
send is refused; without a gate, behaviour is unchanged.

## Policy

`EmailAccount.agentSendPolicy`: null or `require_approval` (default) holds an
agent's send; `auto_send` lets it leave. Only the account owner, as a person,
with tenant `messages.manage-access`, changes it
(`MailAccessService.setAgentSendPolicy`); raising to `auto_send` needs
`confirmAutoSend: true` (the smrt-social public-latch pattern), lowering is
instant, and a change of owner resets it to null. A host per-rule hook (`configureMailSendApprovals({
resolveAgentSendPolicy })`) may answer either way for one send; null falls
back to the account. Non-mail accounts have no policy and are not held.

## Held send

`Message.send()` checks `send` scope, then send-as (on an owned account a
principal sends only from the account's own address), then
`holdAgentSend()`. Send-as applies to every mail account (owned or not)
outside system access. For an agent under `require_approval` it:

1. refuses without a configured gate, without a tenant, for an unsaved draft
   or a caller copy that differs from the stored row, and for send-time
   attachment bytes;
2. hashes the stored draft (`mailSendBindingHash`: account, from, to/cc/bcc,
   subject, bodies, threading headers, stored attachment rows and a SHA-256
   of each attachment file's bytes);
3. calls the gate's `check`, which only reports: `pending` or `approved`
   both return `pendingApproval` and send nothing. The agent never sends a
   held draft itself; it goes out once, as the approving person.

A held message is set to `draft` and flagged `isDraft` (a persona route creates it `pending`), so
it leaves every pending/scheduled outbox and a person can decide it. A
persona message is held even under system access, so a system drain never
sends it around its approval. Send-time attachment bytes (for example
`PersonaMessagingService` `attachments`) are refused on a held send: they are
not stored, so no person could review them and nothing could bind them;
store them as `Attachment` rows on the message instead. A refused send of a
`pending`/`scheduled` message is marked `failed` (definite), never left
queued.

After the row is claimed, a send an approval released re-hashes the draft
(attachment rows included); a mismatch fails definitely and sends nothing.
The approval request carries a neutral summary, never mail content: request
and event rows are readable tenant-wide.

The gate is structural; smrt-approvals' `createApprovalMailSendGate`
implements it (kind `messages.mail.send`). smrt-messages has a dev dependency
on smrt-approvals for tests only.

## Deciding

`MailSendApprovalService` acts as the resolved principal, which must be a
person holding `read` and `send` on the draft's account in the same tenant.
Deciding also needs the tenant `messages.send` permission, checked through
smrt-users with no bypass (on an unowned account the per-account decision
checks none). `approve(id, { edits? })` refuses a draft that changed since
the request (`draft_changed`); with edits it approves the revised hash first
(edit-then-approve), then saves the edits; once the approval is complete it
consumes it and sends as the person. `release(id)` sends a request already
approved elsewhere (a generic inbox), only by one of its approvers. Before
any consume every counted approver is re-verified (tenant `messages.send`
and `send` on the account). `reject(id, reason)` keeps the draft.
Double release is prevented by the single-use consume and the send claim.

## Audit and "handled by"

Triage, draft saves and sends stamp `handledById` / `handledByKind` /
`handledAt` on the message (`getHandledBy()`, `threadHandledBy()` for a
thread). When the host runs the action inside smrt-core `withAuditContext()`,
`auditMailAction` writes `messages.draft.save`, `messages.send.held`,
`messages.send.approved[-with-edits]`, `messages.send.rejected`,
`messages.send` (before the provider call; a writer failure stops the send)
and `messages.triage.<action>`. Mail models are not `audit: true`: that makes
every sync and outbox write demand a writer.

Deciding needs an unsent draft or a definitely failed send (`not_a_draft`
otherwise; an outcome-unknown send is never re-approved). On an unowned
(tenant-wide) account the per-account checks pass for any tenant person, the
same authority as sending directly from it.

## Known gaps

- No approval-queue or handled-by Svelte component yet.
- Attachment bytes are re-read by the sender after the post-claim check, a
  narrow window.
- A crash between consume and send leaves a consumed approval and an unsent
  draft; the agent resubmits for a new approval.

## Draft writes

The `draft` scope is needed: `Message.save()` and `Message.delete()`
check it (`assertMailScopeOn`, `access.ts`) for unsent outgoing mail (below)
now or when stored, by id or by the slug a new object would take over (its own
or the one derived from its id), and for both accounts when a row moves. A
draft flag is `isDraft` in any stored form (`true`, `1`, `'1'`, `'true'`). The
stored row decides, whatever class the handle is. The
grants and account owner are read before the write (a single-connection
engine cannot serve the policy handle inside a transaction); the write then
re-reads the stored row and refuses a save that now needs more.
`Attachment.save()`/`delete()` need the same scope when the message they
belong to (or are moved from) is unsent outgoing mail on an owned account
(`isUnsentOutgoing`). Unsent outgoing mail is any row a later send would
transmit: every row that is not `sent` and not received mail. Received mail
is a provider-tagged row (`messageId`, `folderId`, `tweetId` or `slackTs` set)
that is unflagged and still `draft`; `Message.send()` refuses it, so it is a
record. A `draft` row with no provider id, a flagged draft, and `pending`,
`scheduled`, `sending`, `failed` or an unknown status all count. `Message.save()`/
`delete()` apply the same test to the stored row and to the state a row is
moved into, so a received row cannot be relabelled or stripped of its provider
id around the check. A stored `sent` row cannot be moved out of `sent` by a
principal (sent mail is a record). A fresh row in any of these states needs
`draft` too; the only exception is a row the send path itself creates (an
unsaved message being sent) or the persona route queues, which needs `send`
(the route saves through a module-private helper, `saveQueuedForSend`, valid
only for a fresh row). A save that changes only `isRead` and `isFlagged` of a
stored row needs neither scope, so triage marks work on queued rows, and
`markAllRead` / `markFolderRead` try every row before raising the first error.
A held send's binding hash still covers its attachment rows. The attachment
check runs just before the write, not inside it.
That covers generated routes, collection `delete`/`getOrUpsert`,
`createReply`/`createForward` + `save()` and `MailDraftService`. Trusted work
(`runWithMailSystemAccess`: sync, outbox, triage write-back, approval edits)
skips it. The send lifecycle's own saves and a held send's move back to draft
need `send` instead, and only while every stored field outside the lifecycle
fields (`sendStatus`, `sentAt`, `sendError`, `retryCount`, handled-by,
`updatedAt`) is unchanged, tenant, slug, context and subclass fields included.
A row the send path itself creates (an unsaved message being sent) needs
`send` too (a queued row whose account no longer exists is marked `failed`
with nothing else changed, without a scope). As for read, triage and send, a
principal's scope and account ceilings apply to unowned accounts too; with no principal an owned account is
closed and an unowned one is open.
