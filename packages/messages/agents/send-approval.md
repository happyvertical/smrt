# Agent send policy, held sends, drafts and "handled by" (#5141)

Epic I (happyvertical.com#585). Code: `src/send-approval.ts`,
`src/mail-drafts.ts`, the send path in `src/models/Message.ts`.

## Who is an agent

The host supplies the acting principal through `configureMailAccess`'s
`resolvePrincipal`. Only `kind: 'person'` (or `'human'`) is a person;
anything else, including no label, is an agent. No principal (sync, the
notification outbox, `runWithMailSystemAccess`, a host without
`configureMailAccess`) is neither: nothing is held or stamped.

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
`holdAgentSend()`. For an agent under `require_approval` it:

1. refuses without a configured gate, without a tenant, for an unsaved draft
   or a caller copy that differs from the stored row, and for send-time
   attachment bytes;
2. hashes the stored draft (`mailSendBindingHash`: account, from, to/cc/bcc,
   subject, bodies, threading headers and stored attachment rows);
3. calls the gate's `check`: `pending` returns `pendingApproval` and sends
   nothing; `approved` (after re-verifying that every counted approver holds
   `send` on the account now, then a single-use consume) lets the send run.

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
`approve(id, { edits? })` refuses a draft that changed since the request
(`draft_changed`); with edits it approves the revised hash first
(edit-then-approve), then saves the edits; once the approval is complete it
consumes it and sends as the person. `reject(id, reason)` keeps the draft.
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
- Attachment bytes are bound by row (path, size, type), not file content.
- A crash between consume and send leaves a consumed approval and an unsent
  draft; the agent resubmits for a new approval.
