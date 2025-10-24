# SMRT Framework: Architecture and Development Guide

## Overview

The SMRT Framework is a TypeScript monorepo for building vertical AI agents with built-in code generation, database persistence, and AI-powered operations. It follows these core principles:

- Pure TypeScript implementation for consistency
- Self-contained framework with minimal external dependencies
- AI-first design with built-in intelligent operations
- Automatic code generation for APIs, CLI, and MCP servers
- Type-safe operations across all interfaces

## History

SMRT was split from the [HAppyVertical SDK](https://github.com/happyvertical/sdk) in October 2024 to create a focused, self-contained framework. The SDK now uses SMRT as an external dependency.

## Monorepo Structure

The SMRT framework is organized as a pnpm workspace with the following packages:

### SMRT Packages (`packages/`)

**Core Framework:**
- **core**: Core framework with ORM, code generation, and AI integration
- **types**: Shared TypeScript type definitions
- **config**: Configuration management with cosmiconfig integration

**Domain Modules:**
- **accounts**: Accounting ledger with multi-currency support
- **agents**: Agent framework for autonomous actors
- **assets**: Asset management with versioning and metadata
- **content**: Content processing (documents, PDFs, web content)
- **events**: Event management with participants and hierarchies
- **gnode**: Federation library for local knowledge bases
- **places**: Place management with geo integration
- **products**: Product catalog and microservice template
- **profiles**: Profile management with relationships
- **tags**: Hierarchical tagging system

**External SDK Dependencies:**
The framework depends on these infrastructure packages from @happyvertical/sdk:
- **@happyvertical/ai**: Multi-provider AI client (OpenAI, Anthropic, Google, AWS)
- **@happyvertical/files**: File system operations and utilities
- **@happyvertical/sql**: Database operations (SQLite, Postgres, DuckDB)
- **@happyvertical/utils**: Shared utility functions
- **@happyvertical/logger**: Logging infrastructure

## Development Patterns

### Dependency Management

- Package versioning is synchronized across the monorepo
- Internal dependencies use `workspace:*` to reference other packages
- External dependencies are kept to a minimum
- pnpm 9.0+ is required for package management
- Node.js 24+ is required for runtime

### Build Process

The build process follows a specific order to respect internal dependencies:

1. `@happyvertical/smrt-types` (shared type definitions)
2. `@happyvertical/smrt-config` (configuration management)
3. `@happyvertical/smrt-core` (core framework - depends on types and config)
4. Domain modules (depend on core): accounts, agents, assets, content, events, gnode, places, products, profiles, tags

External dependencies from @happyvertical/sdk are installed from npm.

### TypeScript Project References

The framework uses TypeScript project references for proper type resolution across packages.

#### Configuration Requirements

Each package must have:
1. `composite: true` in its tsconfig.json
2. `outDir`, `rootDir`, and `tsBuildInfoFile` properly configured
3. Entry in root tsconfig.json `references` array

**Root tsconfig.json references:**
```json
{
  "references": [
    { "path": "./packages/types" },
    { "path": "./packages/config" },
    { "path": "./packages/core" },
    { "path": "./packages/accounts" },
    { "path": "./packages/agents" },
    { "path": "./packages/assets" },
    { "path": "./packages/content" },
    { "path": "./packages/events" },
    { "path": "./packages/gnode" },
    { "path": "./packages/places" },
    { "path": "./packages/products" },
    { "path": "./packages/profiles" },
    { "path": "./packages/tags" }
  ]
}
```

### Code Style and Conventions

- Code formatting is enforced by Biome
- Spaces (2) for indentation
- Single quotes for strings
- Line width of 80 characters
- ESM module format exclusively
- camelCase for variables/functions, PascalCase for classes
- Conventional commits
- pnpm for package management

### Testing

- Tests are written using Vitest
- Each package has its own test suite
- Run tests with `npm test` or `npm run test:watch`

### Common Development Commands

```bash
# Install dependencies
pnpm install

# Run tests
npm test

# Build all packages in correct order
npm run build

# Watch mode development
npm run dev

# Lint code
npm run lint

# Format code
npm run format
```

## Development Workflows

### ⚠️ Pre-Work Checklist (READ FIRST)

**BEFORE MAKING ANY CHANGES, VERIFY:**

- [ ] **Am I on main branch?** → If YES, **STOP!** Create a feature branch first
- [ ] **Do I have an issue number?** → If NO, create one or work without (for minor changes)
- [ ] **Am I on a feature branch?** → If NO, create one following the naming convention below

**⚠️ NEVER PUSH DIRECTLY TO MAIN** - Always use feature branches and pull requests.

**Feature branch naming**: `{type}/issue-{number}-{short-description}`
- Examples: `feat/issue-123-new-feature`, `fix/issue-45-bug-fix`, `docs/issue-89-update-readme`
- Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`

### SOP: Starting Work on an Issue

**IMPORTANT**: This SOP should be followed automatically whenever beginning implementation work, whether explicitly asked or implied.

**Related Standards**:
- [Organization-Wide Testing Standard](../TESTING_STANDARD.md) - Must be followed for all test writing
- [Definition of Ready](https://github.com/happyvertical/sdk/blob/main/docs/workflow/DEFINITION_OF_READY.md) - Issue readiness criteria
- [Definition of Done](https://github.com/happyvertical/sdk/blob/main/docs/workflow/DEFINITION_OF_DONE.md) - PR completion checklist

#### When This SOP Triggers

This procedure triggers in these scenarios:
- User mentions implementing/working on an issue (e.g., "let's work on #270")
- User asks to start implementing a feature/fix
- Beginning any implementation work (even without explicit issue number)
- Returning to work after interruption

#### Step 1: Verify Git State

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

#### Step 2: Sync with Main Branch

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

#### Step 3: Identify Issue(s) and Context

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

#### Step 4: Create or Checkout Feature Branch

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

#### Step 5: Planning Phase (Interactive Mode Only)

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

#### Step 6: Create Task List (If Applicable)

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

#### Step 7: Begin Implementation

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

#### Exception Handling

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

### SOP: Creating a Pull Request

**IMPORTANT**: This SOP should be followed automatically when work is complete, before pushing changes.

**Related Standards**:
- [Organization-Wide Testing Standard](../TESTING_STANDARD.md) - Enforced by code reviewer
- [Definition of Done](https://github.com/happyvertical/sdk/blob/main/docs/workflow/DEFINITION_OF_DONE.md) - Verified before PR creation
- [Code Reviewer Agent](./.claude/agents/code-reviewer.md) - Automated review process

#### When This SOP Triggers

This procedure triggers when:
- User indicates work is complete ("ready", "done", "create PR", etc.)
- User says "push" or "ready for review"
- Work appears complete based on context

**DO NOT trigger** when:
- Work is still in progress
- Tests are failing
- User is experimenting or exploring

#### Step 1: Verify Work Completion

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

#### Step 2: Run Quality Checks

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
```

**Track results**:
- Note which checks passed/failed
- Capture error messages for failed checks

#### Step 3: Auto-Fix Issues (If Any)

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

#### Step 4: Run Code Review Agent (Optional)

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

#### Step 5: Squash Commits

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

#### Step 6: Create PR Body

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

#### Step 7: Push and Create PR

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

#### Step 8: Return to Main Branch

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

#### Exception Handling

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

## Cross-Package Dependencies

The packages have these dependency relationships:

**Within SMRT framework:**
- `@happyvertical/smrt-types`: No internal dependencies
- `@happyvertical/smrt-config`: No internal dependencies
- `@happyvertical/smrt-core`: Depends on `@happyvertical/smrt-types`, `@happyvertical/smrt-config`, and external SDK packages (`@happyvertical/*`)
- Domain modules: All depend on `@happyvertical/smrt-core`, some have cross-dependencies:
  - `@happyvertical/smrt-assets` → depends on `@happyvertical/smrt-tags`
  - `@happyvertical/smrt-events` → depends on `@happyvertical/smrt-places`, `@happyvertical/smrt-profiles`

**External dependencies:**
All SMRT packages can depend on SDK infrastructure packages (`@happyvertical/ai`, `@happyvertical/files`, `@happyvertical/sql`, `@happyvertical/utils`, `@happyvertical/logger`) which are installed from npm.

When adding new features, maintain this dependency hierarchy to avoid circular dependencies within the SMRT framework.

## SMRT Framework Core Concepts

The SMRT package provides:

- **Object-Relational Mapping**: Automatic database schema generation from TypeScript classes
- **AI-First Design**: Built-in `do()` and `is()` methods for AI-powered operations
- **Collection Management**: Standardized CRUD operations with flexible querying
- **Code Generation**: Automatic CLI, REST API, and MCP server generation
- **Vite Plugin Integration**: Virtual module system for seamless development

For detailed SMRT framework documentation, see [packages/core/CLAUDE.md](./packages/core/CLAUDE.md).

## Three-Tier MCP Architecture

The SMRT framework provides three tiers of Model Context Protocol (MCP) servers for AI integration:

### Tier 1: Auto-Generated Project MCP Servers

Project-specific MCP servers are automatically generated from your SMRT objects and deployed alongside your application.

**Generation:**
```bash
# CLI command
npx smrt generate-mcp \
  --name my-project-mcp \
  --version 1.0.0 \
  --modular \
  --debug

# Programmatic API
import { MCPGenerator } from '@happyvertical/smrt-core/generators';

const generator = new MCPGenerator({
  name: 'my-project-mcp',
  version: '1.0.0'
});

await generator.generateServer({
  outputPath: '.smrt/mcp-server/index.js',
  modular: true,
  debug: false,
  generateClaudeConfigFile: true,
  generateReadme: true
});
```

**Output Structure:**

Single-file (default):
```
.smrt/
└── mcp-server/
    ├── index.js                    # Complete MCP server
    ├── claude-desktop-config.json  # Optional Claude Desktop config
    └── README.md                   # Optional documentation
```

Modular (--modular flag):
```
.smrt/
└── mcp-server/
    ├── index.js                    # Main entry point
    ├── config.ts                   # Server configuration
    ├── tools/
    │   └── index.ts               # Tool definitions
    ├── handlers/
    │   └── index.ts               # Tool call handlers
    ├── claude-desktop-config.json
    └── README.md
```

**Features:**
- Auto-discovers SMRT objects via ObjectRegistry
- Generates tools for all MCP-enabled actions (list, get, custom actions)
- Uses @happyvertical/smrt-config for configuration loading
- Supports both debug and production modes
- Default output: `.smrt/mcp-server/index.js`

**Configuration:**

Generated servers use @happyvertical/smrt-config to load configuration from:
- Environment variables (SMRT_AI_PROVIDER, SMRT_AI_MODEL, etc.)
- Config files (.smrt-config.js, smrt.config.js, package.json)
- Programmatic configuration via config.load()

### Tier 2: SMRT Advisor MCP (@happyvertical/smrt-dev-mcp)

Development-focused MCP server for code generation and project introspection during development.

**Installation:**
```bash
# Add to Claude Desktop config
{
  "mcpServers": {
    "smrt-dev-mcp": {
      "command": "npx",
      "args": ["-y", "@happyvertical/smrt-dev-mcp"]
    }
  }
}
```

**Tools:**

1. **generate-smrt-class**: Generate complete SMRT class code
   ```typescript
   // Input
   {
     className: "Product",
     properties: [
       { name: "name", type: "text", required: true },
       { name: "price", type: "decimal", required: true }
     ],
     includeApiConfig: true,
     includeMcpConfig: true,
     includeCliConfig: true
   }

   // Output: Full TypeScript class with @smrt() decorator
   ```

2. **introspect-project**: Scan project for SMRT objects
   ```typescript
   // Input
   {
     directory: "./src",
     includeFields: true,
     includeRelationships: true
   }

   // Output: JSON with discovered objects, fields, methods, relationships
   {
     projectPath: "./src",
     objectCount: 5,
     objects: [
       {
         className: "Product",
         filePath: "models/product.ts",
         fields: "name: text, price: decimal",
         methods: "async analyze()",
         relationships: "categoryId -> Category (foreignKey)"
       }
     ]
   }
   ```

**Use Cases:**
- AI-assisted SMRT class creation
- Project structure discovery
- Codebase exploration and documentation
- Rapid prototyping with AI guidance

### Tier 3: SMRT Documentation MCP (@happyvertical/smrt-docs-mcp)

Documentation-focused MCP server providing access to SMRT framework documentation, best practices, and examples.

**Installation:**
```bash
{
  "mcpServers": {
    "smrt-docs-mcp": {
      "command": "npx",
      "args": ["-y", "@happyvertical/smrt-docs-mcp"]
    }
  }
}
```

**Tools:**

1. **search-docs**: Search SMRT framework documentation
2. **get-example**: Retrieve code examples for specific patterns
3. **explain-concept**: Get detailed explanations of SMRT concepts

**Use Cases:**
- Learning SMRT framework patterns
- Looking up API documentation
- Finding example implementations
- Troubleshooting common issues

### Architecture Benefits

**Separation of Concerns:**
- Tier 1: Runtime application data and operations
- Tier 2: Development-time code generation and introspection
- Tier 3: Framework knowledge and documentation

**Layered Workflow:**
```
┌─────────────────────────────────────────────────┐
│ Claude (AI Assistant)                           │
└─────────────────────────────────────────────────┘
         │
         ├──────► Tier 3: smrt-docs-mcp
         │        (Framework knowledge)
         │
         ├──────► Tier 2: smrt-dev-mcp
         │        (Code generation)
         │
         └──────► Tier 1: my-project-mcp
                  (Application data)
```

**Example Workflow:**

1. **Learn** (Tier 3): "How do I create a SMRT object with relationships?"
2. **Generate** (Tier 2): "Generate a Product class with a categoryId foreign key"
3. **Develop**: Write business logic, add custom actions
4. **Deploy** (Tier 1): Generate project MCP server for runtime AI integration
5. **Operate** (Tier 1): AI interacts with live application data

### Configuration Management

All three tiers use @happyvertical/smrt-config for consistent configuration:

**Environment Variables:**
```bash
export SMRT_AI_PROVIDER=claude-cli
export SMRT_AI_MODEL=sonnet
export SMRT_AI_API_KEY=your-key
```

**Config Files:**
```typescript
// .smrt-config.js or smrt.config.js
export default {
  ai: {
    provider: 'claude-cli',
    model: 'sonnet'
  }
};
```

**Programmatic:**
```typescript
import { config } from '@happyvertical/smrt-config';

const appConfig = await config.load();
const aiConfig = appConfig?.ai || {};
```

### Generated Server Customization

**Modular Structure Benefits:**
- Separate concerns into config.ts, tools/, handlers/
- Easy to extend with custom tools
- Better code organization for large projects
- Easier to debug and maintain

**Debug Mode:**
```bash
# Enable debug logging
npx smrt generate-mcp --debug

# Generated server includes:
const DEBUG = true;
if (DEBUG) {
  console.error(`[server-name] Tool called: ${name}`);
}
```

**Custom Actions:**

SMRT objects define custom actions via methods + MCP configuration:

```typescript
@smrt({
  mcp: { include: ['list', 'get', 'analyze', 'summarize'] }
})
class Document extends SmrtObject {
  title = text();
  content = text();

  // Custom action: automatically generates 'document_analyze' MCP tool
  async analyze(options: any = {}) {
    return {
      action: 'analyze',
      wordCount: this.content.split(/\s+/).length,
      sentiment: 'positive'
    };
  }

  // Custom action: automatically generates 'document_summarize' MCP tool
  async summarize(options: any = {}) {
    return {
      action: 'summarize',
      summary: await this.do(`Summarize in ${options.length || 3} sentences`)
    };
  }
}
```

**Generated Tools:**
- `document_list` (CRUD)
- `document_get` (CRUD)
- `document_analyze` (custom action)
- `document_summarize` (custom action)

### Migration from Old Architecture

**Before (SDK MCP Server):**
- Single monolithic SDK MCP server
- Mixed runtime and development tools
- No project-specific customization

**After (Three-Tier):**
- Tier 1: Auto-generated project MCPs (runtime)
- Tier 2: SMRT Advisor (development)
- Tier 3: Documentation (learning)

**Migration Steps:**

1. Generate project MCP server:
   ```bash
   npx smrt generate-mcp --name my-project-mcp
   ```

2. Update Claude Desktop config:
   ```json
   {
     "mcpServers": {
       "my-project-mcp": {
         "command": "node",
         "args": ["/path/to/.smrt/mcp-server/index.js"]
       },
       "smrt-dev-mcp": {
         "command": "npx",
         "args": ["-y", "@happyvertical/smrt-dev-mcp"]
       },
       "smrt-docs-mcp": {
         "command": "npx",
         "args": ["-y", "@happyvertical/smrt-docs-mcp"]
       }
     }
   }
   ```

3. Restart Claude Desktop

### Best Practices

**Development:**
- Use Tier 2 (smrt-dev-mcp) for code generation during development
- Use Tier 3 (smrt-docs-mcp) to learn framework patterns
- Regenerate Tier 1 MCP server when adding new SMRT objects

**Production:**
- Deploy only Tier 1 (project MCP) to production
- Use environment variables for configuration
- Enable debug mode for troubleshooting, disable in production

**Testing:**
- Test generated MCP servers with real SMRT objects
- Verify custom actions work correctly
- Validate MCP protocol compliance

**Gitignore:**
```gitignore
# Auto-generated SMRT files
**/.smrt/
```

### Related Documentation

- **MCP Generator API**: [packages/core/src/generators/mcp.ts](./packages/core/src/generators/mcp.ts)
- **SMRT Dev MCP Tools**: [packages/smrt-dev-mcp/](./packages/smrt-dev-mcp/)
- **Core Framework**: [packages/core/CLAUDE.md](./packages/core/CLAUDE.md)
- **Configuration**: [packages/config/](./packages/config/)

## Contribution Guidelines

1. Ensure code passes Biome linting (`npm run lint`)
2. Write tests for new functionality
3. Update package documentation when adding features
4. Follow existing code patterns in each package
5. Run the full test suite before submitting changes

## Git Branching Strategy

**IMPORTANT**: Never push directly to `main`. Always use feature branches and pull requests.

**Branch Naming Convention**:
```
feat/issue-XXX-short-description      # New features
fix/issue-XXX-short-description       # Bug fixes
docs/issue-XXX-short-description      # Documentation updates
refactor/issue-XXX-short-description  # Code refactoring
test/issue-XXX-short-description      # Test additions/updates
```

## Issue Triage and Management

The SMRT repository uses automated AI-powered issue triage to ensure consistent handling of bugs, feature requests, and questions.

### Triage System

- **AI-Powered Triage**: Automatically analyzes, labels, and prioritizes issues using `@happyvertical/github-actions`
- **Priority Levels**: P0 (Critical), P1 (High), P2 (Medium), P3 (Low)
- **Issue Templates**: Structured bug reports and feature requests (.github/ISSUE_TEMPLATE/)
- **Stale Management**: Automatic cleanup of inactive issues after 30+ days

### Documentation

- **Triage SOP**: [.github/TRIAGE_SOP.md](.github/TRIAGE_SOP.md) - Complete standard operating procedure
- **Issue Templates**: [.github/ISSUE_TEMPLATE/](.github/ISSUE_TEMPLATE/) - Bug reports and feature requests
- **Workflows**: [.github/workflows/](.github/workflows/) - Automated triage and stale issue management

### Triage Workflow

1. **Issue Opened**: AI analyzes content and suggests labels/priority
2. **Manual Review**: Maintainers confirm or adjust AI suggestions within response time targets
3. **Assignment**: Issues are assigned based on priority and component
4. **Stale Detection**: Issues without activity for 30 days are marked stale
5. **Auto-Close**: Stale issues without response for 14 additional days are closed

### Response Time Targets

- **P0-Critical**: < 1 hour (production outages, security issues)
- **P1-High**: < 4 hours (major functionality broken)
- **P2-Medium**: < 2 business days (non-blocking bugs, feature requests)
- **P3-Low**: < 1 week (nice-to-have features, minor issues)

See [.github/TRIAGE_SOP.md](.github/TRIAGE_SOP.md) for complete details.

## Recent Infrastructure Changes

Important PRs that modified development workflow, tooling, or publishing:

### PR #81 - CLI Spinner TTY Detection (Oct 2024)
**Issue**: #80

**Changes**:
- Fixed CLI crash in non-TTY environments (tsx, CI/CD, pipes)
- Added TTY detection before using clearLine/cursorTo methods
- Graceful fallback to console.log when TTY unavailable
- Added regression test for non-TTY spinner behavior

**Impact**: CLI commands (list, create, etc.) now work reliably in all environments including tsx, CI pipelines, and piped output.

**Reference**: https://github.com/happyvertical/smrt/pull/81

### PR #79 - Database Adapter Method Migration (Oct 2024)
**Issue**: #78

**Changes**:
- Replaced raw SQL queries with semantic database adapter methods
- Converted `db.pluck()`, `db.query()`, `db.execute()` to `db.get()`, `db.list()`, `db.delete()`
- Improved cross-adapter compatibility (SQLite, Postgres, DuckDB, JSON)
- Better type safety and maintainability
- Simplified LIKE pattern handling

**Impact**: Code is now more maintainable, type-safe, and works consistently across all database adapters.

**Reference**: https://github.com/happyvertical/smrt/pull/79

### PR #77 - System Tables Initialization Tracking (Oct 2024)
**Issue**: #35

**Changes**:
- Simplified system tables initialization tracking
- Fixed race conditions in concurrent initialization
- Improved database setup reliability

**Impact**: More reliable database initialization, especially for concurrent operations.

**Reference**: https://github.com/happyvertical/smrt/pull/77

### PR #44 - GitHub Packages Publishing & Testing Standard (Oct 2024)
**Issues**: #43, #42, #38
**Branch**: `feat/issue-38-42-43-github-packages-testing`

**Changes**:
- Configured automated publishing to GitHub Packages via semantic-release
- Added `.npmrc` and `publishConfig` to all packages for GitHub Packages registry
- Updated GitHub Actions workflow with `packages:write` permission
- Created comprehensive testing standard adoption plan (TESTING_ADOPTION_PLAN.md)
- Removed build artifacts from git tracking (439 files, 38K deletions)

**Impact**: Packages now publish to `npm.pkg.github.com` automatically on main branch merges. Users need `GITHUB_TOKEN` with `read:packages` scope to install packages.

**Reference**: https://github.com/happyvertical/smrt/pull/44

### PR #41 - Workflow SOPs and Code Review Agent (Oct 2024)
**Issues**: #39, #40

**Changes**:
- Added "Start Work on Issue" SOP to CLAUDE.md
- Added "Create Pull Request" SOP to CLAUDE.md
- Created automated code review agent (`.claude/agents/code-reviewer.md`)
- Integrated Gemini MCP for AI-powered code review

**Impact**: Standardized development workflow with automated quality checks before PR creation.

**Reference**: https://github.com/happyvertical/smrt/pull/41

## Release Management

The framework uses semantic-release for automated versioning and publishing:

```bash
# Preview release
npm run release:preview

# Dry run
npm run release:dry-run

# Full release (CI handles this)
npm run release
```

## Tooling Configuration

- **TypeScript**: Configured for ES2023 with strict type checking
- **Biome**: Used for linting and formatting
- **pnpm**: Package management with workspace support
- **Vitest**: Testing framework
- **Vite**: Build tool for all packages

## Documentation

The framework includes automatic API documentation generation using TypeDoc:

```bash
# Generate documentation (per package)
cd packages/core
npm run docs
```

## Related Projects

- **[HAppyVertical SDK](https://github.com/happyvertical/sdk)**: Infrastructure packages that use SMRT
- **[create-gnode](https://github.com/happyvertical/create-gnode)**: CLI for creating federated local knowledge bases
- **[praeco](https://github.com/happyvertical/praeco)**: Local news agent built on SMRT

## License

MIT License - see LICENSE file for details

## Contact

- GitHub: https://github.com/happyvertical
- SMRT Issues: https://github.com/happyvertical/smrt/issues

---

*This framework was split from the HAppyVertical SDK to create a focused, self-contained foundation for building vertical AI agents.*
