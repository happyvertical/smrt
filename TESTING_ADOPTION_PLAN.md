# Testing Standard Adoption Plan for SMRT Framework

This document outlines how the SMRT framework will adopt the HappyVertical organization-wide testing standard documented in the main repos directory.

## Overview

**Goal**: Align SMRT framework testing with organization-wide standards to improve test quality, maintainability, and documentation value.

**Standard Document**: See `../TESTING_STANDARD.md` in the main repos directory

**Related Issues**:
- SDK #270 (reference implementation)
- SMRT #38 (this initiative)

## Current State

The SMRT framework currently has:
- Some existing tests using various patterns
- Mix of unit and integration tests
- Limited README example coverage
- Inconsistent testing approaches across packages

## Target State

Following the organization-wide testing standard:

### Test Types & Naming

| Pattern | Purpose | SMRT Usage |
|---------|---------|------------|
| `*.test.ts` | Unit tests | Pure functions, business logic |
| `*.spec.ts` | Integration tests | Real databases, AI providers |
| `*.examples.test.ts` | Cookbook examples | Common SMRT patterns |
| `*.optional.test.ts` | Optional tests | External API calls |

### Core Principles for SMRT

1. **Real Resources Over Mocks**:
   - Use in-memory SQLite/DuckDB for database tests
   - Test with real Agent instances
   - Mock only external AI API calls (use test providers)

2. **BDD/TDD Workflow**:
   - Write tests from user stories
   - Bug reports → failing test → fix → keep test

3. **README Examples as Tests**:
   - Every code example in CLAUDE.md must have a test
   - Tests serve as executable documentation

## SMRT-Specific Testing Guidelines

### Testing Agents

```typescript
// ✅ Good: Test with real agent instances
describe('Agent Creation', () => {
  it('should create agent with working API endpoints', async () => {
    const agent = await Agent.create({
      name: 'test-agent',
      objects: [Product],
    });

    const product = new Product({ name: 'Test', price: 29.99 });
    await product.save();

    expect(product.id).toBeDefined();
  });
});

// ❌ Bad: Testing internal implementation
it('should call generateAPI with correct parameters', () => {
  const mockGenerator = vi.fn();
  // ... testing mocks instead of behavior
});
```

### Testing Smart Objects

```typescript
describe('Smart Object AI Methods', () => {
  it('should use AI to validate content', async () => {
    const mockAI = new MockAIProvider();
    mockAI.responses = ['{"result": true}'];

    const product = new Product({
      name: 'Test Product',
      ai: mockAI
    });

    const isValid = await product.is('has a name');
    expect(isValid).toBe(true);
  });
});
```

### Testing Code Generation

```typescript
describe('Generated REST API', () => {
  it('should respond to generated endpoints', async () => {
    const agent = await Agent.create({
      objects: [Product],
      api: { port: 3001 }
    });

    const response = await fetch('http://localhost:3001/api/products');
    expect(response.status).toBe(200);

    await agent.shutdown();
  });
});
```

## Migration Plan

### Phase 1: Audit & Categorize (Week 1)

**Goal**: Understand current testing state

**Tasks**:
- [ ] Audit all existing tests in SMRT packages
- [ ] Categorize tests:
  - **Delete**: Overly-mocked tests with no value
  - **Rewrite**: Tests worth keeping but poorly written
  - **Keep**: Well-written tests matching standard
- [ ] Identify README examples without tests
- [ ] Document package-specific testing needs

### Phase 2: Delete & Rewrite (Weeks 2-4)

**Priority Packages** (in order):
1. `@smrt/types` - Foundation types
2. `@smrt/core` - Core framework
3. Domain modules - accounts, agents, assets, etc.

**Tasks per package**:
- [ ] Delete tests that only verify mocks
- [ ] Rewrite as integration tests with real resources
- [ ] Add missing tests for README examples
- [ ] Write example tests for common patterns

### Phase 3: Documentation (Week 5)

**Tasks**:
- [ ] Update CLAUDE.md with testing guidelines
- [ ] Create SMRT testing guide with examples
- [ ] Document how to test:
  - Agent creation and lifecycle
  - Smart object AI methods
  - Code generation artifacts
  - Database operations
  - MCP server integration
- [ ] Add example tests for common patterns
- [ ] Ensure all package READMEs have tested examples

## Package-Specific Considerations

### Core Framework (`@smrt/core`)

**Test Focus**:
- Agent lifecycle (create, start, stop)
- Decorator application (`@smrt()`)
- AI method execution (`.do()`, `.is()`)
- Database persistence
- Code generation outputs

**Real Resources**:
- In-memory SQLite for database tests
- Temp directories for generated code
- Mock AI providers for AI method tests

### Domain Modules

**Test Focus**:
- Model CRUD operations
- Relationship loading
- Business logic methods
- Schema generation

**Real Resources**:
- In-memory databases
- Real model instances
- Mock AI for content processing

## Success Metrics

### Quantitative
- [ ] >80% coverage of public API
- [ ] Integration tests complete in <5 seconds each
- [ ] Every README example has corresponding test
- [ ] <1% flaky test rate

### Qualitative
- [ ] Tests demonstrate how to use SMRT
- [ ] Tests read like executable documentation
- [ ] Tests break on behavior changes, not implementation
- [ ] New developers learn SMRT from test examples

## Configuration Updates

### Package Scripts

All packages should have:

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "test:integration": "vitest run --include '**/*.spec.ts'",
    "test:examples": "vitest run --include '**/*.examples.test.ts'",
    "test:optional": "vitest run --include '**/*.optional.test.ts'",
    "test:coverage": "vitest run --coverage"
  }
}
```

## Example Tests to Write

### Agent Creation Example

```typescript
// packages/core/src/examples.test.ts
describe('SMRT Framework Examples', () => {
  it('Example: Creating an agent with smart objects', async () => {
    class Product extends SmrtObject {
      name = '';
      price = 0;

      @smrt()
      async summarize(): Promise<string> {
        return this.do('summarize', 'Summarize this product');
      }
    }

    const agent = await Agent.create({
      name: 'product-agent',
      objects: [Product],
      database: { type: 'sqlite', url: ':memory:' },
    });

    const product = new Product({
      name: 'Widget',
      price: 29.99
    });

    await product.save();
    expect(product.id).toBeDefined();

    await agent.shutdown();
  });
});
```

## Timeline

| Phase | Duration | Completion Target |
|-------|----------|------------------|
| Phase 1: Audit | 1 week | Week of Nov 11 |
| Phase 2: Rewrite | 3 weeks | Week of Dec 2 |
| Phase 3: Documentation | 1 week | Week of Dec 9 |

## Resources

- **Organization Testing Standard**: `../TESTING_STANDARD.md`
- **SDK Reference**: happyvertical/sdk#270
- **Vitest Documentation**: https://vitest.dev/

## Action Items

### Immediate
- [x] Create adoption plan document (this file)
- [ ] Review and approve plan with team
- [ ] Begin Phase 1 audit

### Short-term (Weeks 2-4)
- [ ] Delete overly-mocked tests
- [ ] Rewrite as integration tests
- [ ] Add missing example tests

### Long-term (Week 5+)
- [ ] Update all documentation
- [ ] Create SMRT testing guide
- [ ] Ensure all examples have tests

---

**Last Updated**: October 2024
**Status**: Draft - Pending Approval
**Labels**: `testing`, `refactoring`, `documentation`, `framework`
