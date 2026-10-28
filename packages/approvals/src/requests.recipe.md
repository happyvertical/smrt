## Overview

Approvals is where you see who has to say yes before something happens, such
as publishing a post or sending an order. Each request names what needs
approval, who asked and where it stands: waiting, approved, rejected, changes
requested, cancelled or expired. The history keeps every step taken on a
request, and the policies show the rules each kind of approval follows.

## Tasks

Requests are raised by the app or by an assistant through the approval
service, decisions are recorded by the same service, and policies are set by
an administrator through it. Nothing here is created or changed by hand in the
app. Here you find a request, see where it stands and read what happened.

### Find a request

1. Open the list of requests.
2. Look at the **{field:ApprovalRequest.summary}** to see what needs approval, and the **{field:ApprovalRequest.kind}** to see what sort of approval it is.
3. Check **{field:ApprovalRequest.requestedBy}** to see who asked.

### See where a request stands

1. Open the request.
2. Its **{field:ApprovalRequest.status}** shows whether it is still waiting, approved, rejected, sent back for changes, cancelled or expired.
3. **{field:ApprovalRequest.expiresAt}** is the deadline: after it a request can no longer be decided.
4. Once decided, **{field:ApprovalRequest.decidedAt}** shows when.

### Read the history of a request

1. Open the history.
2. Find the entries for the **{field:ApprovalEvent.requestId}** you are interested in.
3. Each entry shows **{field:ApprovalEvent.type}**, who did it in **{field:ApprovalEvent.actorId}**, and **{field:ApprovalEvent.occurredAt}**, oldest first.
4. A rejection or cancellation carries its **{field:ApprovalEvent.reason}**.

### Read the rules for a kind of approval

1. Open the policies.
2. Find the **{field:ApprovalPolicy.kind}** you want to know about.
3. **{field:ApprovalPolicy.requiredApprovals}** is how many different people must agree, and **{field:ApprovalPolicy.ttlMs}** is how long a request stays open.
4. **{field:ApprovalPolicy.requiredPermission}** names any extra permission a decider must hold.
