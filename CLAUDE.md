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

### Core Packages (`packages/`)

- **types**: Shared TypeScript type definitions
- **utils**: Base utility functions (slug generation, etc.)
- **logger**: Logging infrastructure with @have/logger
- **files**: File system operations (local and remote)
- **sql**: Database interaction (SQLite, Postgres, DuckDB)
- **ai**: Standardized AI interface (OpenAI, Anthropic, Google Gemini, AWS Bedrock)
- **smrt**: Core framework with object-relational mapping and code generation

## Development Patterns

### Dependency Management

- Package versioning is synchronized across the monorepo
- Internal dependencies use `workspace:*` to reference other packages
- External dependencies are kept to a minimum
- pnpm 9.0+ is required for package management
- Node.js 24+ is required for runtime

### Build Process

The build process follows a specific order to respect internal dependencies:

1. `@have/types` (shared type definitions)
2. `@have/utils` (base utilities)
3. `@have/logger` (logging infrastructure)
4. `@have/files` (file system interactions)
5. `@have/sql` (database interactions)
6. `@have/ai` (AI model interfaces)
7. `@have/smrt` (core framework)

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
    { "path": "./packages/utils" },
    { "path": "./packages/logger" },
    { "path": "./packages/files" },
    { "path": "./packages/sql" },
    { "path": "./packages/ai" },
    { "path": "./packages/smrt" }
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

## Cross-Package Dependencies

The packages have these dependency relationships:

- `types`: No internal dependencies
- `utils`: No internal dependencies
- `logger`: Depends on `types`, `utils`
- `files`: Depends on `utils`
- `sql`: No internal dependencies
- `ai`: No internal dependencies
- `smrt`: Depends on all other packages

When adding new features, maintain this dependency hierarchy to avoid circular dependencies.

## SMRT Framework Core Concepts

The SMRT package provides:

- **Object-Relational Mapping**: Automatic database schema generation from TypeScript classes
- **AI-First Design**: Built-in `do()` and `is()` methods for AI-powered operations
- **Collection Management**: Standardized CRUD operations with flexible querying
- **Code Generation**: Automatic CLI, REST API, and MCP server generation
- **Vite Plugin Integration**: Virtual module system for seamless development

For detailed SMRT framework documentation, see [packages/smrt/CLAUDE.md](./packages/smrt/CLAUDE.md).

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
cd packages/smrt
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
