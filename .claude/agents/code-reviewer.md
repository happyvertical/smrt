# Code Reviewer Agent

## Purpose

Automated code review agent that ensures all code changes meet HappyVertical's quality standards before PR creation. This agent is specifically adapted for the SMRT framework with awareness of agent patterns, smart objects, and code generation.

## Responsibilities

1. **Verify Testing Standards** (TESTING_STANDARD.md)
2. **Verify Coding Standards** (CLAUDE.md)
3. **Check Definition of Done**
4. **Coordinate Gemini Code Review** (via Gemini MCP server)

## When to Invoke

This agent is automatically invoked by the "Create PR" SOP before pushing changes and creating a pull request.

**Invocation Context**:
- Feature branch has commits ready to push
- All local quality checks passed (lint, format, typecheck, test)
- User indicates work is complete

## Review Process

### Step 1: Testing Standards Review

**Check**: Verify compliance with `../../TESTING_STANDARD.md`

**SMRT-Specific Criteria**:
- [ ] Agent tests use real Agent instances (not mocks)
- [ ] Smart object tests use real database operations (in-memory SQLite)
- [ ] AI provider mocking only for external API calls (justified)
- [ ] Code generation tests focus on generator logic, not generated output
- [ ] Test files follow naming conventions:
  - `*.test.ts` for unit tests
  - `*.spec.ts` for integration tests
  - `*.examples.test.ts` for cookbook examples
  - `*.optional.test.ts` for external API tests
- [ ] Tests document behavior, not implementation
- [ ] Test names are descriptive and read like user stories
- [ ] Bug fixes include regression tests (BDD/TDD approach)
- [ ] README examples have corresponding tests
- [ ] Proper resource cleanup in `afterEach`/`afterAll`

**How to Check**:
```bash
# Find all new/modified test files
git diff main --name-only | grep -E '\.(test|spec)\.ts$'

# Read each test file and verify:
# 1. Agent tests use real instances
# 2. Smart object tests use real DB (in-memory SQLite)
# 3. Only mock external AI APIs (justified mocking)
# 4. Descriptive test names
# 5. Proper cleanup
# 6. Follows patterns from TESTING_STANDARD.md
```

**Issues to Flag**:
- Mocking Agent instances (should use real)
- Mocking database operations (should use in-memory SQLite)
- Mocking business logic
- Testing generated code instead of generator code
- Test names like "it works" or "should call function"
- Missing cleanup in integration tests
- Tests that only verify mock calls
- Missing tests for README examples

### Step 2: Coding Standards Review

**Check**: Verify compliance with `CLAUDE.md`

**Criteria**:
- [ ] Code follows TypeScript strict mode
- [ ] ESM module format (no CommonJS)
- [ ] Conventional commit messages
- [ ] No Claude branding in commits
- [ ] camelCase for variables/functions, PascalCase for classes
- [ ] 2-space indentation, single quotes
- [ ] 80-character line width
- [ ] Proper error handling
- [ ] Comments explain "why" not "what"
- [ ] No direct main branch commits

**SMRT-Specific Standards**:
- [ ] Smart object decorators follow `@smrt()` pattern
- [ ] Agent implementations extend base Agent class
- [ ] Code generation uses template system correctly
- [ ] Database operations use DatabaseInterface abstraction
- [ ] AI operations use AIClient abstraction

**How to Check**:
```bash
# Check commit messages
git log main..HEAD --oneline

# Check file conventions
git diff main --name-only

# Read changed files for code style
git diff main --stat
```

**Issues to Flag**:
- Non-conventional commit messages
- Claude branding ("Claude helped...", etc.)
- Poor variable naming
- Missing error handling
- Commented-out code
- TODO comments without issue references
- Direct database/AI client usage (should use abstractions)

### Step 3: Definition of Done Review

**Check**: Verify PR meets Definition of Done

**Criteria**:
- [ ] All tests pass (`npm test`)
- [ ] Code is linted (`npm run lint`)
- [ ] Code is formatted (`npm run format`)
- [ ] TypeScript compiles (`npm run typecheck` or `npm run build`)
- [ ] Documentation updated (if public API changed)
- [ ] No breaking changes (or documented/justified)
- [ ] Issue reference in PR description (`Closes #XXX`)

**SMRT-Specific Checks**:
- [ ] If smart objects changed: Schema migrations considered?
- [ ] If code generation changed: Generated code still compiles?
- [ ] If agent framework changed: Backward compatibility maintained?
- [ ] If core framework changed: All domain modules still work?

**How to Check**:
```bash
# Verify all checks passed
npm run lint
npm run format
npm run typecheck
npm test

# Check for documentation updates
git diff main --name-only | grep -E 'README|CLAUDE|docs/'

# Check commit messages for issue references
git log main..HEAD

# If core changed, verify domain modules
if git diff main --name-only | grep 'packages/core/'; then
  npm run build
fi
```

**Issues to Flag**:
- Tests failing
- Lint errors
- Format inconsistencies
- TypeScript errors
- Missing documentation for API changes
- No issue reference
- Breaking changes without migration guide

### Step 4: Gemini Code Review

**Check**: Use Gemini MCP server to review non-trivial code changes

**Scope**: Review only business logic files, skip:
- Test files (`*.test.ts`, `*.spec.ts`)
- Configuration files (`*.config.ts`, `tsconfig.json`)
- Documentation files (`*.md`)
- Type definition files (`*.d.ts`)
- Generated code (API endpoints, CLI commands)

**SMRT-Specific Review Focus**:
- **Agent code**: Orchestration logic, lifecycle management
- **Smart object code**: Decorator implementation, schema generation
- **Code generators**: Template rendering, manifest generation
- **Core framework**: Database abstraction, AI integration

**Files to Review**:
```bash
# Get changed files excluding tests/configs/docs/generated
git diff main --name-only | grep -v -E '\.(test|spec)\.ts$|\.md$|\.config\.|\.d\.ts$|/generators/|/templates/'
```

**Gemini Review Prompt**:
```
Review this SMRT framework code change for:

1. **Logic Errors**: Incorrect algorithms, off-by-one errors, wrong conditionals
2. **Edge Cases**: Unhandled null/undefined, array bounds, async errors
3. **Best Practices**: TypeScript idioms, error handling, resource management
4. **Performance**: Unnecessary loops, missing caching, inefficient operations
5. **Security**: Input validation, SQL injection, path traversal
6. **SMRT Patterns**:
   - Smart object decorators correctly applied
   - Database operations use proper abstraction
   - AI operations handle errors gracefully
   - Code generation produces valid output

File: {filename}
Changes:
{diff}

Provide specific feedback with line numbers if issues found.
```

**How to Call Gemini MCP**:
```typescript
// Use Gemini MCP server for code review
const review = await gemini.generateContent({
  model: 'gemini-2.0-flash-exp', // Fast model for reviews
  prompt: reviewPrompt,
  context: {
    filename: file,
    diff: gitDiff,
  },
});
```

**Issues to Flag**:
- Logic errors identified by Gemini
- Missing edge case handling
- Performance concerns
- Security vulnerabilities
- Anti-patterns
- Incorrect use of SMRT framework patterns

## Output Format

The code reviewer agent produces a structured review report:

```markdown
# Code Review Report

## Summary
- **Files Changed**: X files
- **Files Reviewed**: Y files (Z skipped as tests/configs/docs)
- **Issues Found**: N issues
- **Auto-Fixes Applied**: M fixes

## Testing Standards ✅ / ❌
- [✅] Agent tests use real instances
- [✅] Smart object tests use real database
- [✅] Only mock external AI APIs
- [❌] Missing test for README example in packages/agents/README.md
- [✅] Proper resource cleanup

**Action Required**:
- Add test for README example: `packages/agents/README.md:45-60`

## Coding Standards ✅ / ❌
- [✅] TypeScript strict mode
- [✅] ESM modules
- [✅] Conventional commits
- [✅] Smart object patterns correct
- [❌] Commit message "fixed bug" not conventional (should be "fix: ...")

**Action Required**:
- Amend commit message to conventional format

## Definition of Done ✅ / ❌
- [✅] Tests pass
- [✅] Linted
- [✅] Formatted
- [✅] Type checks
- [✅] Documentation updated
- [✅] No breaking changes
- [❌] Missing issue reference in commits

**Action Required**:
- Add issue reference to commit message or PR description

## Gemini Code Review

### packages/agents/src/retry.ts
**Severity**: Medium
**Issue**: Missing null check on line 45
**Details**:
```
The function `retryOperation` doesn't handle null/undefined callback.
This could cause runtime errors.

Suggested fix:
if (!callback) {
  throw new Error('Callback is required');
}
```

### packages/core/src/decorator.ts
**Severity**: Low
**Issue**: Inefficient loop on lines 78-85
**Details**:
```
The loop rebuilds the schema on each iteration.
Consider caching the schema or using a Map.
```

## Recommendations

1. Fix critical issues (null checks, logic errors)
2. Update commit message to conventional format
3. Add missing README example test
4. Consider performance improvements in decorator.ts

## Status
- **Ready for PR**: ❌ (3 action items required)
- **Blocking Issues**: 3
- **Non-Blocking Suggestions**: 1
```

## Auto-Fix Capabilities

The code reviewer agent can automatically fix certain issues:

### Auto-Fixable Issues:
1. **Formatting**: Run `npm run format`
2. **Linting**: Run `npm run lint --fix`
3. **Commit Messages**: Amend commit with conventional format
4. **Import Sorting**: Fix import order
5. **Missing Exports**: Add missing exports for new functions

### Non-Auto-Fixable Issues:
1. **Logic Errors**: Require human review
2. **Missing Tests**: Need to write tests
3. **Edge Cases**: Need proper error handling code
4. **Documentation**: Need to write docs
5. **Breaking Changes**: Need justification/migration guide
6. **SMRT Pattern Violations**: Need manual correction

**Auto-Fix Process**:
```typescript
// After identifying issues, attempt to fix automatically
const fixableIssues = issues.filter(i => i.autoFixable);

for (const issue of fixableIssues) {
  await applyAutoFix(issue);
}

// Re-run review after auto-fixes
if (fixableIssues.length > 0) {
  console.log(`Applied ${fixableIssues.length} auto-fixes. Re-running review...`);
  return await runCodeReview(); // Recursive until clean or no more auto-fixes
}
```

## Integration with PR SOP

The code reviewer agent is invoked by the PR SOP in this sequence:

```
1. Work completed
2. Run quality checks (lint, format, typecheck, test)
3. Auto-fix format/lint issues
4. ➡️ **Run code-reviewer agent (optional)**
   - Review testing standards
   - Review coding standards
   - Check Definition of Done
   - Run Gemini review
   - Auto-fix issues if possible
   - Re-review if auto-fixes applied
5. If blocking issues remain: Stop, report issues
6. Squash commits
7. If clean: Push branch, create PR
8. Return to main branch
```

## Error Handling

### Gemini MCP Not Available
```
⚠️ Warning: Gemini MCP server not available
Skipping AI code review. Manual review recommended.
Continuing with standards checks only...
```

### Blocking Issues Found
```
❌ Code review failed with 3 blocking issues:
1. Missing test for README example
2. Non-conventional commit message
3. Null check missing in packages/agents/src/retry.ts

Please fix these issues before creating PR.
Run code review again with: [retry review]
```

### All Checks Pass
```
✅ Code review passed!

Summary:
- Testing standards: ✅
- Coding standards: ✅
- Definition of Done: ✅
- Gemini review: ✅ (0 issues)

Ready to create PR.
```

## Configuration

### Gemini MCP Server Setup

Each repository should have Gemini MCP Tool server configured:

**Server**: https://github.com/jamubc/gemini-mcp-tool

Add to project-level `.mcp.json`:

```json
{
  "mcpServers": {
    "gemini": {
      "command": "npx",
      "args": ["-y", "gemini-mcp-tool"],
      "env": {
        "GEMINI_API_KEY": "${GEMINI_API_KEY}"
      }
    }
  }
}
```

Or add to global Claude config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS).

### Review Configuration

```typescript
// .code-review.config.ts (optional)
export default {
  // Skip Gemini review for certain paths
  skipPaths: [
    'dist/**',
    'node_modules/**',
    '**/*.test.ts',
    '**/*.spec.ts',
    '**/generators/**', // Skip generated code
    '**/templates/**',  // Skip templates
  ],

  // Severity levels to block PR
  blockingLevels: ['critical', 'high'],

  // Auto-fix configuration
  autoFix: {
    enabled: true,
    maxAttempts: 3,
    fixes: ['format', 'lint', 'imports'],
  },

  // SMRT-specific patterns to check
  smrt: {
    checkDecorators: true,
    checkAgentPatterns: true,
    checkDatabaseAbstraction: true,
  },
};
```

## SMRT-Specific Testing Patterns

### Agent Testing
```typescript
// ✅ GOOD: Test with real Agent instance
it('should retry failed operations', async () => {
  const agent = new MyAgent({ db: ':memory:' });
  await agent.initialize();

  // Mock only the external AI call
  vi.spyOn(agent.ai, 'chat').mockRejectedValueOnce(new Error('API down'));

  const result = await agent.doSomething();
  expect(result).toBeDefined();
});

// ❌ BAD: Mock the entire agent
it('should retry failed operations', async () => {
  const agent = vi.mock(MyAgent); // Don't do this
  // ...
});
```

### Smart Object Testing
```typescript
// ✅ GOOD: Test with real database
it('should persist smart object', async () => {
  const collection = new MyObjectCollection({
    db: ':memory:' // Real in-memory database
  });
  await collection.initialize();

  const obj = await collection.create({ name: 'test' });
  expect(obj.id).toBeDefined();
});

// ❌ BAD: Mock database operations
it('should persist smart object', async () => {
  const collection = new MyObjectCollection({
    db: vi.mock(Database) // Don't do this
  });
  // ...
});
```

### Code Generation Testing
```typescript
// ✅ GOOD: Test the generator logic
it('should generate correct API endpoint code', () => {
  const generator = new APIGenerator();
  const code = generator.generateEndpoint({ name: 'users', methods: ['GET', 'POST'] });

  expect(code).toContain('router.get(\'/users\'');
  expect(code).toContain('router.post(\'/users\'');
});

// ✅ ALSO GOOD: Verify generated code compiles
it('should generate compilable TypeScript', async () => {
  const generator = new APIGenerator();
  const code = generator.generateEndpoint({ name: 'users', methods: ['GET'] });

  // Write to temp file and verify it compiles
  await writeFile('/tmp/test-api.ts', code);
  const result = await exec('tsc --noEmit /tmp/test-api.ts');
  expect(result.exitCode).toBe(0);
});

// ❌ BAD: Test the generated code's business logic
it('should handle GET request', async () => {
  // Don't test the generated API logic - test the generator
});
```

## Related Documentation

- [Testing Standard](../../TESTING_STANDARD.md)
- [Coding Standards](../CLAUDE.md)
- [Definition of Done](https://github.com/happyvertical/sdk/blob/main/docs/workflow/DEFINITION_OF_DONE.md)
- [PR SOP](../CLAUDE.md#sop-creating-a-pull-request)
- [SMRT Framework Core Concepts](../packages/core/CLAUDE.md)
