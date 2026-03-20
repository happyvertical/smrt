# SMRT Framework: Development Workflow Guide

This document contains the standard operating procedures (SOPs) for development workflows in the SMRT framework. These workflows are designed for Claude Code integration and ensure consistent, high-quality contributions.

## Table of Contents

- [Pre-Work Checklist](#pre-work-checklist)
- [SOP: Starting Work on an Issue](#sop-starting-work-on-an-issue)
- [SOP: Creating a Pull Request](#sop-creating-a-pull-request)
- [Git Branching Strategy](#git-branching-strategy)

---

## ⚠️ Pre-Work Checklist (READ FIRST)

**BEFORE MAKING ANY CHANGES, VERIFY:**

- [ ] **Am I on main branch?** → If YES, **STOP!** Create a feature branch first
- [ ] **Do I have an issue number?** → If NO, create one or work without (for minor changes)
- [ ] **Am I on a feature branch?** → If NO, create one following the naming convention below

**⚠️ NEVER PUSH DIRECTLY TO MAIN** - Always use feature branches and pull requests.

**Feature branch naming**: `{type}/issue-{number}-{short-description}`
- Examples: `feat/issue-123-new-feature`, `fix/issue-45-bug-fix`, `docs/issue-89-update-readme`
- Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`

---

## SOP: Starting Work on an Issue

**IMPORTANT**: This SOP should be followed automatically whenever beginning implementation work, whether explicitly asked or implied.

**Related Standards**:
- [Organization-Wide Testing Standard](../TESTING_STANDARD.md) - Must be followed for all test writing
- [Definition of Ready](https://github.com/happyvertical/sdk/blob/main/docs/workflow/DEFINITION_OF_READY.md) - Issue readiness criteria
- [Definition of Done](https://github.com/happyvertical/sdk/blob/main/docs/workflow/DEFINITION_OF_DONE.md) - PR completion checklist

### When This SOP Triggers

This procedure triggers in these scenarios:
- User mentions implementing/working on an issue (e.g., "let's work on #270")
- User asks to start implementing a feature/fix
- Beginning any implementation work (even without explicit issue number)
- Returning to work after interruption

### Step 1: Verify Git State

Before any work begins, ensure a clean git state:

```bash
# Check current status
git status

# If there are uncommitted changes: STOP
# DO NOT PROCEED - inform user they must commit or stash changes first
```

**If uncommitted changes exist**:
- Stop the SOP immediately
- Inform the user: "You have uncommitted changes. Please commit or stash them before starting new work."
- Do not attempt to stash or commit automatically
- Wait for user to resolve

**If clean working tree**:
- Proceed to Step 2

### Step 2: Sync with Main Branch

Ensure local main is up-to-date:

```bash
# If not on main, checkout main
git checkout main

# Pull latest changes
git pull origin main
```

**If already on a feature branch**:
- First verify working tree is clean (Step 1)
- Then checkout main and sync
- Claude will create/checkout the correct feature branch in Step 4

### Step 3: Identify Issue(s) and Context

**Interactive Mode** (default):
- If no issue number mentioned, use wizard to ask which issue(s) to work on
- If user mentions issue(s), fetch issue details using `gh issue view #XXX`
- Read the issue description, labels, and comments for context

**Non-Interactive/CI Mode**:
- Issue number must be provided as input
- If missing, exit with error: "Issue number required for non-interactive mode"
- Fetch issue details using `gh issue view #XXX`

**Multiple Issues**:
- If working on multiple related issues, note all issue numbers
- Branch will be named: `{type}/issue-XXX-YYY-short-desc`
- PR will use: `Closes #XXX, Fixes #YYY` syntax

### Step 4: Create or Checkout Feature Branch

**Branch Naming Convention**:
```
{type}/issue-{numbers}-{short-description}

Examples:
feat/issue-270-testing-standard
fix/issue-123-database-connection
docs/issue-45-api-guide
refactor/issue-89-cleanup-cache
test/issue-67-integration-tests
feat/issue-270-271-combined-work  # Multiple issues
```

**Determining Branch Type**:
- Read issue labels and title to infer type (feat/fix/docs/refactor/test)
- Default to `feat` if unclear

**Branch Creation**:
```bash
# Check if branch already exists remotely
git fetch origin

# If branch exists, check it out
git checkout {type}/issue-XXX-short-desc

# If branch does not exist, create it
git checkout -b {type}/issue-XXX-short-desc

# If branch exists remotely but not locally
git checkout -b {type}/issue-XXX-short-desc origin/{type}/issue-XXX-short-desc
```

**Context Awareness**:
- If branch already exists: Assume continuing previous work
- Check last commit message to understand current state
- Review existing changes since branching from main

### Step 5: Planning Phase (Interactive Mode Only)

**IMPORTANT**: Use the AskUserQuestion wizard for ALL clarifying questions.

**Standard Questions to Ask** (use wizard):
1. **Implementation Approach**
   - Technical approach (architecture, design patterns)
   - Library/tool choices
   - Integration points

2. **Scope Clarification**
   - What's in scope vs. out of scope
   - Priority of sub-tasks
   - Must-haves vs. nice-to-haves

3. **SMRT-Specific Questions**:
   - **Agent Work**: Which agents affected? Impact on agent orchestration? Breaking changes to Agent interface?
   - **Smart Object Work**: Which smart objects affected? Decorator testing approach? Database schema changes?
   - **Code Generation Work**: What will be generated (API/CLI/MCP)? How to test generator vs generated code? Template changes needed?
   - **Framework Integration**: Integration with existing patterns? Backward compatibility concerns? Documentation updates?

4. **Test Strategy** (Always Ask):
   - What test types are needed? (unit/integration/examples/optional)
   - Should tests use real resources or mocks? (default: real resources per TESTING_STANDARD.md)
   - For agent creation: Test with real Agent instances, not mocks
   - For smart objects: Test with real database operations, mock AI providers only
   - For code generation: Test the generator code, verify generated code compiles/runs
   - Are README examples affected? (if yes, must add corresponding tests)
   - Is this fixing a bug? (if yes, write failing test first per BDD/TDD workflow)

**Wizard Question Format**:
```typescript
// Use AskUserQuestion with 1-4 questions
// Focus on decisions that can't be standardized
// Avoid asking questions with obvious answers from issue context
```

**Recording Planning Decisions**:
After wizard responses, post a comment to the issue:

```bash
gh issue comment {issue-number} --body "$(cat <<'EOF'
## Planning Notes

### Implementation Approach
[Summary of technical approach decided]

### Scope
- In scope: [list]
- Out of scope: [list]

### Key Decisions
1. [Decision 1 and rationale]
2. [Decision 2 and rationale]

### Test Strategy
Following [Organization-Wide Testing Standard](../TESTING_STANDARD.md):

**Test Types**:
- [ ] Unit tests (`*.test.ts`) - [if needed, describe what]
- [ ] Integration tests (`*.spec.ts`) - [describe real resources to use]
- [ ] Example tests (`*.examples.test.ts`) - [if demonstrating common patterns]
- [ ] Optional tests (`*.optional.test.ts`) - [if using external APIs/expensive resources]

**SMRT-Specific Testing**:
- Agent creation: [Testing with real instances or mock AI?]
- Smart objects: [Testing with real DB, mock AI providers?]
- Code generation: [Testing generator vs generated code?]

**Testing Approach**:
- Using real resources: [SQLite in-memory / temp directories / test server / Docker]
- Mocking only: [list exceptions with justification]
- README examples: [list examples that need corresponding tests]
- BDD/TDD: [if bug fix, describe failing test to write first]

**Test Verification**:
- [ ] Tests document behavior (not implementation)
- [ ] Tests read like executable examples
- [ ] README examples have corresponding tests
- [ ] Following package-specific guidelines (if applicable)

EOF
)"
```

### Step 6: Create Task List (If Applicable)

For complex issues with multiple steps, use TodoWrite to create task list:

```typescript
// Use TodoWrite tool
// Break down work into specific, actionable items
// Use both content (imperative) and activeForm (present continuous)
```

**When to use TodoWrite**:
- Issue has 3+ distinct steps
- Multi-package changes required
- Complex workflow with dependencies

**When to skip TodoWrite**:
- Single straightforward change
- Trivial update
- Simple bug fix

### Step 7: Begin Implementation

**Implementation Order** (following Testing Standard):

For **bug fixes**:
1. Write failing test that reproduces the issue (BDD/TDD approach)
2. Implement fix to make test pass
3. Verify test passes and provides regression protection

For **new features**:
1. Write tests from user stories (integration tests with real resources)
2. Implement feature to make tests pass
3. Add example tests for common usage patterns
4. Update README with examples (and corresponding tests)

For **SMRT-specific work**:
- **Agent features**: Test with real Agent instances, mock only external AI API calls
- **Smart objects**: Test with real database operations (in-memory SQLite), mock AI providers
- **Code generation**: Test the generator logic, verify generated code compiles and runs
- **Framework integration**: Test with real instances, avoid excessive mocking

For **all work**:
- Follow the plan established in Step 5
- Update TodoWrite task list as you progress
- Mark tasks as in_progress → completed as you work
- Follow standard coding conventions from CLAUDE.md
- Follow testing standards from TESTING_STANDARD.md:
  - Use real resources (in-memory DBs, temp files) over mocks
  - Write tests that read like documentation
  - Ensure README examples have corresponding tests
  - Test behavior, not implementation

### Exception Handling

**Merge Conflicts on Main Sync**:
- Stop SOP, inform user
- Ask user to resolve conflicts before continuing

**Branch Already Exists with Different Type**:
- Example: `fix/issue-270-X` exists but labels indicate `feat`
- Use existing branch (don't rename)
- Note the discrepancy for user

**Issue Not Found**:
- If `gh issue view` fails, stop SOP
- Inform user the issue doesn't exist or isn't accessible
- Ask user to verify issue number

**Multiple Remote Branches for Same Issue**:
- List branches and ask user which to use
- Use wizard to present options

---

## SOP: Creating a Pull Request

**IMPORTANT**: This SOP should be followed automatically when work is complete, before pushing changes.

**Related Standards**:
- [Organization-Wide Testing Standard](../TESTING_STANDARD.md) - Enforced by code reviewer
- [Definition of Done](https://github.com/happyvertical/sdk/blob/main/docs/workflow/DEFINITION_OF_DONE.md) - Verified before PR creation
- [Code Reviewer Agent](./.claude/agents/code-reviewer.md) - Automated review process

### When This SOP Triggers

This procedure triggers when:
- User indicates work is complete ("ready", "done", "create PR", etc.)
- User says "push" or "ready for review"
- Work appears complete based on context

**DO NOT trigger** when:
- Work is still in progress
- Tests are failing
- User is experimenting or exploring

### Step 1: Verify Work Completion

Before starting PR process, confirm:

```bash
# Check current branch
git branch --show-current

# Verify on feature branch (not main)
# If on main: Stop, inform user they need to be on a feature branch
```

**If not on feature branch**:
- Stop SOP immediately
- Inform user: "You're on main branch. Create a feature branch first."
- Reference "Start Work on Issue" SOP

**If on feature branch**:
- Proceed to Step 2

### Step 2: Run Quality Checks

Run all quality checks in sequence:

```bash
# 1. Lint
npm run lint

# 2. Format
npm run format

# 3. Type check
npm run typecheck || npm run build

# 4. Tests
npm test

# 5. Full suite for each touched package
pnpm --filter @happyvertical/smrt-<package> test

# 6. Coverage report for each touched package
pnpm --filter @happyvertical/smrt-<package> exec vitest run --coverage
```

**Track results**:
- Note which checks passed/failed
- Capture error messages for failed checks
- Confirm the full suite for every touched package is green, not just newly added targeted tests

### Step 3: Auto-Fix Issues (If Any)

**If lint or format failures**:

```bash
# Attempt auto-fix
npm run lint --fix
npm run format --fix

# Re-run checks
npm run lint
npm run format
```

**If auto-fix succeeds**:
- Continue to next check
- Note auto-fixes applied

**If auto-fix fails**:
- Stop SOP
- Show errors to user
- Message: "Please fix lint/format errors manually and try again"
- Exit

**If typecheck or tests fail**:
- Stop SOP immediately (cannot auto-fix)
- Show errors to user
- Message: "Fix TypeScript errors / failing tests before creating PR"
- Exit

**If all checks pass**:
- Proceed to Step 4

### Step 4: Run Code Review Agent (Optional)

**NOTE**: The code review agent from issue #39 is optional and may not be implemented yet. This step can be skipped if the agent is not available.

If code-reviewer agent exists, invoke it to verify quality standards:

```bash
# Invoke code-reviewer agent (via Task tool or direct delegation)
# See .claude/agents/code-reviewer.md for details
```

**Code Reviewer Checks** (when available):
1. Testing standards (TESTING_STANDARD.md)
2. Coding standards (CLAUDE.md)
3. Definition of Done
4. Gemini code review (non-trivial files only, via Gemini MCP)

**If blocking issues found**:
- Stop SOP
- Show code review report to user
- Message: "Code review found {N} blocking issues. Please fix and try again."
- Exit

**If code reviewer not available**:
- Skip this step and proceed to Step 5
- Manual review will happen during PR review process

### Step 5: Squash Commits

Combine all commits on the feature branch into a single commit:

```bash
# Get first commit on branch
FIRST_COMMIT=$(git merge-base main HEAD)

# Count commits to squash
COMMIT_COUNT=$(git rev-list --count ${FIRST_COMMIT}..HEAD)

# If more than 1 commit, squash using reset + commit approach
if [ $COMMIT_COUNT -gt 1 ]; then
  git reset --soft ${FIRST_COMMIT}
  git commit -m "$(generate_commit_message)"
fi
```

**Commit Message Format** (Conventional Commits):
```
{type}({scope}): {description}

{body}

Closes #{issue-number}
```

**Examples**:
```
feat(agents): add retry mechanism for failed operations

- Implement exponential backoff retry strategy
- Add configurable retry limits and delays
- Add integration tests with real Agent instances
- Add example tests for common retry patterns
- Update README with retry configuration examples

Closes #123

fix(core): handle null values in smart object upsert

Fixes issue where null values were being converted to undefined,
causing database constraint violations in DuckDB.

- Add null value handling in upsert method
- Add regression test reproducing the issue
- Verified fix with SQLite, Postgres, and DuckDB

Closes #45
```

**Generate commit message**:
- Use `{type}` from branch name (feat/fix/docs/refactor/test)
- Use `{scope}` from package name or area changed (agents, core, assets, etc.)
- Use `{description}` from issue title or summary
- Include `{body}` with bullet list of changes
- Include `Closes #{issue-number}` from issue

### Step 6: Create PR Body

Generate comprehensive PR description using this template:

```markdown
## Summary

{Summary of what was implemented, referencing planning notes from issue}

## Changes

{Bullet list of key changes:}
- {Feature/fix/refactor implemented}
- {Files modified or added}
- {Integration points}

## Testing

Following [Organization-Wide Testing Standard](../TESTING_STANDARD.md):

**Test Types Added**:
- [x] Unit tests (`*.test.ts`) - {describe what}
- [x] Integration tests (`*.spec.ts`) - {describe what}
- [x] Example tests (`*.examples.test.ts`) - {if applicable}
- [ ] Optional tests (`*.optional.test.ts`) - {if applicable}

**SMRT-Specific Testing**:
- Agent testing: {Real instances, mock AI providers, etc.}
- Smart object testing: {Real DB operations, mock AI, etc.}
- Code generation testing: {Generator tests, verification of generated code}

**Testing Approach**:
- Used real resources: {SQLite in-memory / temp directories / test server / etc.}
- Mocked only: {list exceptions with justification, or "None"}
- README examples: {list examples with corresponding tests, or "No examples affected"}
- BDD/TDD: {if bug fix, note regression test added}

**Test Results**:
```
✅ All tests pass (X passing)
✅ New tests: Y added
✅ Coverage: Z% of changed code
```

## Code Review

**Standards Verified**:
- ✅ Testing standards (TESTING_STANDARD.md)
- ✅ Coding standards (CLAUDE.md)
- ✅ Definition of Done

{If code reviewer agent was used, include its output here}

## Checklist

- [x] Tests pass
- [x] Code linted
- [x] Code formatted
- [x] TypeScript compiles
- [x] Documentation updated (if applicable)
- [x] Conventional commit message
- [x] Issue reference included

Closes #{issue-number}
```

**Variables to fill**:
- `{Summary}`: From issue planning notes or commit body
- `{Changes}`: Extract from git diff and commit message
- `{Test Types}`: Check which test files were added
- `{Testing Approach}`: Analyze test files for resource usage
- `{issue-number}`: From branch name or commits

### Step 7: Push and Create PR

Push the branch and create the pull request:

```bash
# Push branch to remote
git push origin $(git branch --show-current)

# Create PR with gh CLI
gh pr create \
  --title "$(git log -1 --pretty=%s)" \
  --body "$(cat <<'EOF'
{PR body from Step 6}
EOF
)"
```

**PR Title**: Use the commit subject line (first line of squashed commit)

**PR Labels** (auto-apply based on type):
- `feat/*` → label: `enhancement`
- `fix/*` → label: `bug`
- `docs/*` → label: `documentation`
- `refactor/*` → label: `refactoring`
- `test/*` → label: `testing`

### Step 8: Return to Main Branch

After PR created, return to main branch:

```bash
# Checkout main
git checkout main

# Pull latest (in case main was updated)
git pull origin main

# Inform user
echo "✅ PR created: {PR URL}"
echo "✅ Returned to main branch"
echo "You can continue with other work or wait for review feedback"
```

**Leave feature branch**:
- Feature branch remains on remote for review
- User can return to it if review feedback requires changes
- Branch will be deleted automatically after PR merge (GitHub setting)

### Exception Handling

**Not on Feature Branch**:
- Stop immediately
- Message: "You're on {branch}. Please create a feature branch first."
- Reference "Start Work on Issue" SOP

**Quality Checks Fail (Non-Auto-Fixable)**:
- Stop immediately
- Show errors clearly
- Message: "Fix {lint/typecheck/tests} errors and try again"
- Do not create PR

**Code Review Finds Blocking Issues**:
- Stop immediately
- Show code review report
- List each blocking issue with file:line
- Message: "Fix {N} blocking issues and run review again"

---

## Git Branching Strategy

**IMPORTANT**: Never push directly to `main`. Always use feature branches and pull requests.

### Branch Naming Convention

```
feat/issue-XXX-short-description      # New features
fix/issue-XXX-short-description       # Bug fixes
docs/issue-XXX-short-description      # Documentation updates
refactor/issue-XXX-short-description  # Code refactoring
test/issue-XXX-short-description      # Test additions/updates
```

### Conventional Commits

All commits must follow the Conventional Commits specification:

**Format**: `<type>(<scope>): <subject>`

**Types**:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation changes
- `style`: Code style changes (formatting, missing semi-colons, etc.)
- `refactor`: Code refactoring (neither fixes bug nor adds feature)
- `perf`: Performance improvements
- `test`: Adding or updating tests
- `build`: Changes to build system or dependencies
- `ci`: Changes to CI configuration
- `chore`: Other changes that don't modify src or test files
- `revert`: Revert a previous commit

**Scope**: Package name or affected area (e.g., `core`, `agents`, `assets`)

**Examples**:
```
feat(core): add TypeScript-first pattern support
fix(agents): resolve memory leak in agent pool
docs(readme): update installation instructions
refactor(core): simplify database adapter interface
test(core): add integration tests for eager loading
```

For more info: https://www.conventionalcommits.org/

---

This workflow guide is optimized for Claude Code integration and ensures consistent, high-quality contributions to the SMRT framework. For high-level contribution guidelines, see [CONTRIBUTING.md](./CONTRIBUTING.md).
