# Lead approval planning integration

Session train: `happyvertical/smrt`, release line `0.57`, branch
`codex/lead-planning-conversion`, based on `04f0ccfc9f` (0.57.20).
One commit per item with `Refs #N`; one integrated PR when publication is
explicitly resumed, closing every item. No release, push, or full suite during
this local development phase. HappyVertical Work consumes the sibling build
through an ignored native pnpm hook and isolated lock; committed family pins
remain unchanged under the user's explicit local-development override.

Ordered items:

1. #4245: LeadConversionService records pending downstream targets without won
   status, exact replay preserves provenance, changed intent and foreign tenant
   access fail closed. Reverse target lookup and pure read mode are public.
2. #4246: TenantInvitationService prepares pending identity/membership, issues
   membership-bound signed single-use proof, and accepts only that exact scope.
   No outbound email or session minting. Grants never authenticate identity;
   independent first-class sessions or protocol-verified exact OIDC identity
   are mandatory. Named high risk: identity binding and access activation;
   root must include an auth/security review.
3. #4249: LeadWorkflowService corrects contact fields under the existing tenant
   transaction/row lock and appends one audit; exact retry is a no-op and audit
   failure rolls the correction back. Identity/acquisition provenance survives.

Focused evidence: sales `lead-conversion.test.ts` and `lead-workflow.test.ts`
(22 tests); users `tenant-invitation.test.ts` (17 tests); package typecheck,
build, and packed-export verification. SQLite tests cover ownership/context,
wrong child/user/role, expiry/replay, suspended identity and caller rollback.
Logs: `/tmp/smrt4245-*`, `/tmp/smrt4246-*`, `/tmp/smrt4249-*`.
Native consumer graph: 46 active SMRT names at 0.57.20, one core and Svelte
instance; existing Work Vite dedupe resolves both smrt-svelte peer variants to
one UI runtime. Real Work adapter tests consume these packages directly.

At integration end: run the documented full validation and PostgreSQL-sensitive
users checks once on the integrated source, then one high-risk review-cycle.
All remaining review, validation, release, adoption and publication decisions
stay with the coordinating root session. Never merge without authorization.


Additional user-required auth item #4254: independent emailed mailbox proof for
pending invitation onboarding and active returning-client login. Never expose
proof to the project-grant issuer. Reuse canonical token nonces and login limiter,
no schema/outbox/provider feature. Retried requests preserve grant; completion
claims both nonces atomically. Existing session ceilings and identity remain.
Focused users mailbox/invitation/magic-link/limiter tests plus package types/build/
exports; adapter-aware mailbox suite registered in PostgreSQL checks, including
concurrent completion winners. Coordinator owns final PostgreSQL/full validation
and independent auth review before the now-authorized integrated release.
