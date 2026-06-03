---
name: smrt-review
description: Use when reviewing a downstream SMRT project. Fetch deterministic SMRT and HappyVertical SDK context from smrt-dev-mcp, inspect the actual code diff, and produce a findings-first code review.
---

# SMRT Review

Use this skill for code reviews in projects that use SMRT packages or generated
SMRT surfaces.

## Workflow

1. Determine the repository root and changed files.
   - Prefer the user's explicit changed-file list.
   - Otherwise use the active harness's git support or `git diff --name-only`.
   - Include staged files when the user is preparing a commit.
2. Call MCP tool `smrt-review` from `smrt-dev-mcp` with:

```json
{
  "rootDir": "/absolute/path/to/project",
  "changedFiles": ["relative/path/from/root.ts"],
  "focus": "Review SMRT usage, relationships-v2 patterns, tenancy, generated API/CLI/MCP compatibility, SDK usage, prompt/data safety, and stale docs.",
  "mode": "both"
}
```

3. Treat `deterministicFindings` as required review routing, not as the whole
   review. A routing warning means the code needs focused scrutiny; do not
   report it as a defect unless the actual diff confirms a concrete issue.
4. Read the actual changed diff and any referenced files needed to understand
   behavior. Do not review from the MCP context alone.
5. Use `promptBundle.contextMarkdown` as current SMRT ecosystem context for
   selected packages and SDKs. When generated facts conflict with authored
   guidance, trust generated facts and flag the doc drift.
6. Produce a findings-first review. Prioritize correctness, regressions,
   missing tests, generated-surface compatibility, relationship/tenant
   invariants, data exposure, and stale docs.
7. If code, docs, or package expertise changed, call MCP tool
   `check-knowledge-freshness` with `{ "strict": true }` when available, or
   tell the user to run:

```bash
pnpm knowledge:check --strict --format markdown
```

## Required Review Focus

- Relationships-v2: `@foreignKey`, `@crossPackageRef`, `SmrtJunction`,
  `SmrtHierarchical`, polymorphic `(metaType, metaId, role)` links, qualified
  `_meta_type`, UUID id/FK columns, and tenant-guarded relationship loads.
- Generated surfaces: public exports, CLI commands, REST handlers, generated MCP
  tool names/schemas, and AI-operation compatibility.
- Tenancy: nullable tenant semantics, tenant context propagation, and explicit
  cross-tenant exceptions.
- SDK usage: prefer HappyVertical SDK packages for AI, SQL, files, logging,
  secrets, jobs, and external capability adapters.
- Agent docs: `AGENTS.md` is canonical; `CLAUDE.md` must remain exactly the
  `@AGENTS.md` shim.

## Output

Lead with findings ordered by severity. Use file and line references when the
harness can provide them. If no issues are found, say that clearly and mention
the validation or residual risk. Keep summaries secondary to findings.

See `references/review-output.md` for a stricter output template when the user
asks for a formal review.
