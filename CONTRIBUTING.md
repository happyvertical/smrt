# Contributing to SMRT Framework

Thank you for your interest in contributing to the SMRT Framework! This document provides high-level guidelines for contributing. For detailed step-by-step workflows, see [WORKFLOW.md](./WORKFLOW.md).

## Quick Links

- **Detailed Workflows**: [WORKFLOW.md](./WORKFLOW.md) - Step-by-step SOPs for development
- **Testing Standards**: [TESTING_STANDARD.md](../TESTING_STANDARD.md) - Organization-wide testing requirements
- **Architecture**: [CLAUDE.md](./CLAUDE.md) - Framework overview and patterns
- **Core Documentation**: [packages/core/CLAUDE.md](./packages/core/CLAUDE.md) - Detailed technical reference

## Getting Started

### Prerequisites

- **Node.js**: 24+ required
- **pnpm**: 9.0+ required
- **Git**: For version control
- **GitHub CLI**: `gh` for PR management

### Installation

```bash
# Clone the repository
git clone https://github.com/happyvertical/smrt.git
cd smrt

# Install dependencies
pnpm install

# Build all packages
npm run build

# Run tests
npm test
```

## How to Contribute

### 1. Find or Create an Issue

- Browse [existing issues](https://github.com/happyvertical/smrt/issues)
- Check if your contribution addresses an existing issue
- If not, [create a new issue](https://github.com/happyvertical/smrt/issues/new) describing your proposal

### 2. Follow the Development Workflow

See [WORKFLOW.md](./WORKFLOW.md) for detailed SOPs:
- **Starting Work**: Pre-work checklist, git setup, branch creation, planning
- **Creating PRs**: Quality checks, commit squashing, PR description

**Quick Summary**:
1. Create feature branch: `{type}/issue-{number}-{short-description}`
2. Implement changes following coding standards
3. Write tests following [TESTING_STANDARD.md](../TESTING_STANDARD.md)
4. Run quality checks: `npm run lint && npm test`
5. Create PR with conventional commit message

### 3. Code Review

All contributions go through code review:
- Maintainers review PRs for quality, tests, and documentation
- Address feedback promptly
- Keep PRs focused and reasonably sized

## Code Standards

### Code Style

- **Format**: Biome for linting and formatting
- **Indentation**: 2 spaces (no tabs)
- **Quotes**: Single quotes for strings
- **Line Width**: 80 characters maximum
- **Modules**: ESM only, no CommonJS

**Auto-format**:
```bash
npm run format       # Format all files
npm run lint --fix   # Auto-fix linting issues
```

### TypeScript

- Strict type checking enabled
- No `any` types without justification
- Full type coverage for public APIs
- Use TypeScript project references for cross-package types

### Testing Requirements

All code changes must include tests. See [TESTING_STANDARD.md](../TESTING_STANDARD.md) for complete requirements.

**Key Principles**:
- Use real resources (in-memory DBs, temp files) over mocks
- Tests should read like documentation
- Follow BDD/TDD for bug fixes
- README examples must have corresponding tests

**Test Types**:
- **Unit tests** (`*.test.ts`): Fast, isolated component tests
- **Integration tests** (`*.spec.ts`): Real resource integration
- **Example tests** (`*.examples.test.ts`): Demonstrate common patterns
- **Optional tests** (`*.optional.test.ts`): Expensive or external API tests

### SMRT-Specific Patterns

**TypeScript-First Approach**:
```typescript
// ✅ PREFERRED: Use TypeScript types for most properties
class Product extends SmrtObject {
  name: string = '';
  price: number = 0.0;    // DECIMAL (has decimal point)
  quantity: number = 0;   // INTEGER (no decimal point)

  // Field helpers only when needed
  categoryId = foreignKey(Category);
  sku = text({ required: true, unique: true });
}
```

**The 0 vs 0.0 Heuristic**:
- `number = 0` → INTEGER column (no decimal point)
- `number = 0.0` → DECIMAL column (has decimal point)

See [packages/core/CLAUDE.md](./packages/core/CLAUDE.md#typescript-types-vs-field-helpers) for complete guidance.

## Documentation

### When to Update Documentation

Update documentation when you:
- Add new features or APIs
- Change existing behavior
- Fix bugs that aren't obvious
- Add examples or patterns

### Documentation Files

- **CLAUDE.md files**: For AI assistants and contributors
- **README.md files**: User-facing API documentation
- **Code comments**: For complex logic or non-obvious decisions

### Documentation Style

- Clear, concise language
- Code examples for all APIs
- Link to related documentation
- Keep examples up-to-date

## Git Workflow

### Branch Naming

```
feat/issue-XXX-short-description      # New features
fix/issue-XXX-short-description       # Bug fixes
docs/issue-XXX-short-description      # Documentation
refactor/issue-XXX-short-description  # Refactoring
test/issue-XXX-short-description      # Tests
```

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <subject>

<body>

Closes #<issue-number>
```

**Examples**:
```
feat(core): add TypeScript-first pattern support
fix(agents): resolve memory leak in agent pool
docs(readme): update installation instructions
```

### Pull Requests

- One PR per issue/feature
- Squash commits before merging
- Include issue reference in commit
- Fill out PR template completely

See [WORKFLOW.md](./WORKFLOW.md#sop-creating-a-pull-request) for detailed PR creation process.

## Review Process

### What We Look For

✅ **Code Quality**:
- Follows TypeScript and ESM standards
- Proper error handling
- No security vulnerabilities

✅ **Testing**:
- All tests pass
- New code has test coverage
- Tests follow TESTING_STANDARD.md
- README examples have tests

✅ **Documentation**:
- API changes documented
- Examples provided
- CLAUDE.md updated if needed

✅ **Process**:
- Conventional commit message
- Issue referenced
- No unrelated changes

### Response Time Targets

- **P0-Critical**: < 1 hour
- **P1-High**: < 4 hours
- **P2-Medium**: < 2 business days
- **P3-Low**: < 1 week

## Common Contribution Scenarios

### Adding a New Feature

1. Create issue describing the feature
2. Get feedback from maintainers
3. Follow [WORKFLOW.md](./WORKFLOW.md) for implementation
4. Include tests and documentation
5. Create PR

### Fixing a Bug

1. Create issue with reproduction steps
2. Write failing test that reproduces bug (BDD/TDD)
3. Implement fix to make test pass
4. Verify fix doesn't break existing tests
5. Create PR

### Improving Documentation

1. Identify documentation gap or error
2. Create issue (optional for minor fixes)
3. Update relevant documentation files
4. Ensure examples are accurate
5. Create PR

### Adding Tests

1. Identify untested code
2. Write tests following TESTING_STANDARD.md
3. Ensure tests pass
4. Create PR

## Getting Help

- **Questions**: [GitHub Discussions](https://github.com/happyvertical/smrt/discussions)
- **Bugs**: [GitHub Issues](https://github.com/happyvertical/smrt/issues)
- **Documentation**: [CLAUDE.md](./CLAUDE.md) and [packages/core/CLAUDE.md](./packages/core/CLAUDE.md)
- **Workflow**: [WORKFLOW.md](./WORKFLOW.md)

## Code of Conduct

- Be respectful and constructive
- Focus on the code, not the person
- Welcome newcomers and help them learn
- Assume good intentions

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

---

Thank you for contributing to SMRT! Your efforts help make this framework better for everyone. 🎉
