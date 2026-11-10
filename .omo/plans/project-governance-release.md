# Coordinated SMRT project workflow release

Owner-authorized session train, repository happyvertical/smrt, release line 0.57.x (automation chooses next compatible version), branch codex/4140-project-governance. One ready PR, one attributed commit per item, all included issues closed in PR. No app-local copies or links in Work; consume published exact family release only. Root coordinating session retains merge/release authority.

Ordered items:
1. #4140 tenant/project isolated questions and decisions, explicit owner resolution separate from discussion; internal/client visibility; append-only history; revision conflict protection and reusable panel.
2. #4230 canonical project specification with validated Cookbook v1 snapshot, scoped optimistic writes, explicit caller transaction rollback.
3. #4231 canonical participant development intake without integration spoofing, requester-scoped retry identity and audit trail; preserve managed ingress and participant split behavior.

Risk: high, named triggers tenant isolation, participant authorization boundary and persisted schema additions. Host supplies project/actor authorization, platform vs client projection, and notification recipients. No generic workflow engine or production deploy. Existing smrt-chat discussion and smrt-messages notification services remain canonical.

Validation: focused package tests/typecheck/build, full touched projects suite; then pnpm install/build/test/typecheck/lint/format-check, knowledge:check --strict --format markdown, audit:policy. PostgreSQL required CI validates dialect before merge; local workers run SQLite only, no service stack. Full review once integrated, two independent advanced reviewers due high-risk triggers, final exact HEAD covered. Release via existing batched release workflow only after required CI and queue gates pass and root coordinates.

Evidence: /Users/will/Work/tmp/smrt-governance-evidence. Claim review identity: happyvertical-smrt-4140-6272108166.
