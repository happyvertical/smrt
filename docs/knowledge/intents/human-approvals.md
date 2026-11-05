---
type: Capability
title: "Human approval steps"
description: "Reach for smrt-approvals ApprovalService before writing an approved flag, a status column or an approval table."
tags:
  - smrt
  - intent
status: draft
generated:
  by: claude/smrt-4687
  at: 2026-11-05T00:00:00Z
stale_after: 2027-02-03T00:00:00Z
audience: internal
evidence_level: source-inspected
package_version: 0.60.8
sources:
  - id: s1
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/approvals/src/service.ts
    path: packages/approvals/src/service.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/approvals/src/service.ts (ApprovalService.decide, requestApproval, consume)"
  - id: s2
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/approvals/src/kinds.ts
    path: packages/approvals/src/kinds.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/approvals/src/kinds.ts (defineApprovalKind, assertPolicyTightens)"
  - id: s3
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/approvals/AGENTS.md
    path: packages/approvals/AGENTS.md
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/approvals/AGENTS.md (invariants)"
---

# Human approval steps

# Entry point

Import from `@happyvertical/smrt-approvals`. Register a kind with `defineApprovalKind({ ... })` (default quorum, TTL, required permissions, optional self-approval permission), construct an `ApprovalService`, and call `requestApproval(principal, input)` when an agent or service needs a human gate, `decide(principal, requestId, { decision, reason })` for the human outcome, and `consume()` to spend an approved request exactly where the gated action happens. Tenants may tighten a kind through `ApprovalPolicy`. This is a decision gate and ledger, not a workflow engine.

# Why not hand-roll it

`ApprovalService.decide()` in `service.ts` refuses any principal whose type is not `human` (`not_human`), refuses the requester unless the kind grants a self-approval permission (`self_approval`), checks every permission the request snapshot requires, refuses a non-pending or expired request, and allows one decision per actor.[^s1] Per the package invariants every transition is one guarded UPDATE on tenant, status, version and expiry plus an append-only `ApprovalEvent` in one transaction, so two concurrent approvers cannot both win, and `assertPolicyTightens()` rejects a policy that lowers quorum or lengthens expiry.[^s2][^s3] An `approved` boolean cannot tell who approved, whether they were the requester, or whether the approval was already used.

# Component pages

- [smrt-approvals](/components/smrt-approvals.md)

# Detection signals

- `regex:approved_by`
- `regex:status\s*=\s*['"]approved['"]`
- `regex:require_?[aA]pproval`

[^s1]: `packages/approvals/src/service.ts` at `478ae36900`: ApprovalService.decide, requestApproval, consume.
[^s2]: `packages/approvals/src/kinds.ts` at `478ae36900`: defineApprovalKind, assertPolicyTightens.
[^s3]: `packages/approvals/AGENTS.md` at `478ae36900`: invariants.
