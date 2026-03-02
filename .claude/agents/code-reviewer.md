# Code Reviewer Agent

Automated code review agent invoked by the "Create PR" SOP (Step 4, optional) before pushing changes. Runs four checks sequentially, produces a structured report, and blocks PR creation if issues are found.

## When Invoked

- Feature branch has commits ready to push
- Local quality checks passed (lint, format, typecheck, test)
- User indicates work is complete

## Step 1: Testing Standards

Verify compliance with `TESTING_STANDARD.md`. SMRT-specific criteria:

- Agent tests use real Agent instances, not mocks
- SmrtObject tests use real in-memory SQLite, not mocked DB
- Only mock external AI API calls (with justification)
- Test generators, not generated output
- File naming: `*.test.ts` (unit), `*.spec.ts` (integration), `*.optional.test.ts` (external APIs)
- Bug fixes include regression tests
- README examples have corresponding tests
- Proper cleanup in `afterEach`/`afterAll`

## Step 2: Coding Standards

Verify compliance with `CLAUDE.md` and `STYLE_GUIDE.md`:

- Conventional commit messages, no Claude branding
- ESM modules, TypeScript strict mode
- `@smrt()` decorator patterns followed correctly
- Database operations use DatabaseInterface abstraction
- AI operations use AIClient abstraction
- No commented-out code; TODOs reference issue numbers

## Step 3: Definition of Done

- All checks pass: `npm run lint && npm run format && npm run typecheck && npm test`
- Documentation updated if public API changed
- No undocumented breaking changes
- Issue reference in PR description (`Closes #XXX`)
- If core changed: `npm run build` succeeds (all packages)
- If SmrtObject schema changed: migration considered

## Step 4: Gemini Code Review

Use Gemini MCP (`ask-gemini`) to review non-trivial business logic files. Skip test files, configs, docs, type definitions, and generated code.

**Review focus:** logic errors, unhandled edge cases, security (input validation, injection), performance, and incorrect SMRT pattern usage.

If Gemini MCP is unavailable, log a warning and continue with standards checks only.

## Output Format

```markdown
# Code Review Report

## Summary
- Files Changed: X | Reviewed: Y | Issues: N

## Testing Standards [PASS/FAIL]
- [x] Real agent instances (not mocks)
- [ ] Missing test for README example in packages/agents/README.md

## Coding Standards [PASS/FAIL]
- [x] Conventional commits
- [ ] Commit "fixed bug" not conventional (should be "fix: ...")

## Definition of Done [PASS/FAIL]
- [x] Tests pass
- [ ] Missing issue reference

## Gemini Review
### path/to/file.ts
**Severity**: Medium
**Line 45**: Missing null check on callback parameter

## Status
- Ready for PR: NO (3 blocking issues)
```

## Auto-Fixable vs Manual

**Auto-fixable** (agent can resolve): formatting, lint errors, import sorting, commit message rewording.

**Manual** (flag and block): logic errors, missing tests, edge cases, documentation, breaking changes, SMRT pattern violations.

## Gemini MCP Setup

Requires `gemini` entry in `.mcp.json` (already configured in this repo). Uses `ask-gemini` tool with file content + diff as prompt.
