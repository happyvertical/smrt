# @happyvertical/smrt-docs-mcp: SMRT Documentation MCP (Tier 3)

## Purpose and Responsibilities

The SMRT Documentation MCP is a **learning and documentation-focused MCP server** that provides AI-powered access to SMRT framework documentation, best practices, code examples, and troubleshooting guides. It serves as the knowledge base for developers learning and working with the SMRT framework.

**Tier 3 Position in MCP Architecture:**
- **Tier 1 (Runtime)**: Auto-generated project MCP servers for application data and operations
- **Tier 2 (Development)**: Code generation and project introspection tools
- **Tier 3 (Documentation)**: 👈 **You are here** - Framework knowledge and documentation access

## Installation

### NPX (Recommended for Ad-Hoc Usage)

```bash
# Run directly without installation
npx -y @happyvertical/smrt-docs-mcp
```

### Claude Desktop Integration

Add to your Claude Desktop configuration (`~/Library/Application\ Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "smrt-docs-mcp": {
      "command": "npx",
      "args": ["-y", "@happyvertical/smrt-docs-mcp"]
    }
  }
}
```

After adding, restart Claude Desktop to activate the MCP server.

### Global Installation (Optional)

```bash
npm install -g @happyvertical/smrt-docs-mcp

# Then use in Claude Desktop config:
{
  "mcpServers": {
    "smrt-docs-mcp": {
      "command": "smrt-docs-mcp"
    }
  }
}
```

## Available Tools

### 1. search-docs

Searches the SMRT framework documentation for specific topics, concepts, or keywords. Returns relevant documentation sections with context and examples.

**Input Parameters:**
```typescript
{
  query: string;               // Search query (keywords, phrases, or questions)
  scope?: string;              // Limit search to specific areas: 'core', 'api', 'cli', 'mcp', 'guides'
  includeExamples?: boolean;   // Include code examples in results (default: true)
}
```

**Search Capabilities:**
- Full-text search across all documentation
- Semantic search for concept-based queries
- Code example search and retrieval
- Cross-reference navigation

**Example Usage:**

```typescript
// Input: Concept-based search
{
  query: "How do I define relationships between SMRT objects?",
  scope: "core",
  includeExamples: true
}

// Output: Relevant documentation with examples
{
  results: [
    {
      title: "Relationship Definitions",
      section: "Field System - Relationships",
      content: "...",
      examples: [
        {
          code: "categoryId = foreignKey(Category, { onDelete: 'restrict' })",
          description: "Foreign key relationship example"
        }
      ],
      relatedTopics: ["foreignKey", "oneToMany", "manyToMany"]
    }
  ]
}
```

**Use Cases:**
- Learning SMRT framework patterns
- Looking up API documentation
- Finding implementation examples
- Understanding framework concepts
- Troubleshooting common issues

### 2. get-example

Retrieves specific code examples for common SMRT framework patterns. Provides complete, runnable code snippets with explanations.

**Input Parameters:**
```typescript
{
  pattern: string;            // Pattern name or description
  category?: string;          // Example category: 'object', 'collection', 'api', 'mcp', 'cli'
  complexity?: string;        // Complexity level: 'basic', 'intermediate', 'advanced'
}
```

**Available Example Categories:**
- **object**: SMRT object definitions, fields, methods
- **collection**: Collection management, querying, relationships
- **api**: REST API generation and customization
- **mcp**: MCP server generation and configuration
- **cli**: CLI command generation and usage

**Example Usage:**

```typescript
// Input: Get foreign key relationship example
{
  pattern: "foreign key relationship",
  category: "object",
  complexity: "basic"
}

// Output: Complete code example
{
  title: "Foreign Key Relationship Example",
  description: "Defining a foreign key relationship between objects",
  code: `
import { SmrtObject } from '@happyvertical/smrt-core';
import { text, foreignKey } from '@happyvertical/smrt-core/fields';
import { smrt } from '@happyvertical/smrt-core';
import { Category } from './category';

@smrt({ api: true, mcp: true })
class Product extends SmrtObject {
  name = text({ required: true });
  categoryId = foreignKey(Category, {
    onDelete: 'restrict',
    onUpdate: 'cascade'
  });

  async loadCategory() {
    return await this.loadRelated('categoryId');
  }
}

export default Product;
  `,
  explanation: "...",
  relatedExamples: ["oneToMany relationship", "manyToMany relationship"],
  documentation: "See packages/core/CLAUDE.md#field-system for details"
}
```

**Use Cases:**
- Quick reference for common patterns
- Copy-paste starting points for implementation
- Learning by example
- Verifying correct usage patterns
- Comparing different approaches

### 3. explain-concept

Provides detailed explanations of SMRT framework concepts, architecture decisions, and design patterns. Returns comprehensive information with diagrams, examples, and related concepts.

**Input Parameters:**
```typescript
{
  concept: string;           // Concept name or question
  depth?: string;            // Explanation depth: 'overview', 'detailed', 'comprehensive'
  includeComparisons?: boolean; // Include comparisons to alternatives (default: false)
}
```

**Explainable Concepts:**
- **Framework Architecture**: Core concepts, design decisions
- **Object System**: SmrtObject, SmrtCollection, fields
- **Code Generation**: How generators work, virtual modules
- **MCP Integration**: Three-tier architecture, tool generation
- **AI Integration**: `is()`, `do()` methods, function calling
- **Database Adapters**: Cross-adapter compatibility, querying
- **Performance**: Caching, eager loading, optimization strategies

**Example Usage:**

```typescript
// Input: Explain three-tier MCP architecture
{
  concept: "three-tier MCP architecture",
  depth: "detailed",
  includeComparisons: true
}

// Output: Comprehensive explanation
{
  title: "Three-Tier MCP Architecture",
  summary: "...",
  explanation: {
    overview: "The SMRT framework uses a three-tier MCP architecture...",
    tier1: {
      description: "Auto-generated project-specific MCP servers...",
      purpose: "Runtime application data and operations",
      examples: ["..."]
    },
    tier2: {
      description: "Development-focused code generation tools...",
      purpose: "Development-time assistance",
      examples: ["..."]
    },
    tier3: {
      description: "Documentation and learning tools...",
      purpose: "Framework knowledge access",
      examples: ["..."]
    }
  },
  diagrams: ["..."],
  comparisons: {
    alternative: "Single monolithic MCP server",
    advantages: ["Separation of concerns", "Better organization", "..."],
    tradeoffs: ["More packages to manage", "..."]
  },
  relatedConcepts: ["MCPGenerator", "Virtual Modules", "Code Generation"]
}
```

**Use Cases:**
- Understanding framework architecture
- Learning design patterns and rationale
- Making informed architectural decisions
- Evaluating trade-offs and alternatives
- Deep-dive technical explanations

## Documentation Coverage

### Core Framework Documentation

**Packages:**
- `@happyvertical/smrt-core` - Core framework and ORM
- `@happyvertical/smrt-config` - Configuration management
- `@happyvertical/smrt-types` - Shared type definitions

**Topics:**
- Object and collection patterns
- Field system and schema generation
- AI integration (`is()`, `do()`, function calling)
- Database adapters and querying
- Code generation (CLI, API, MCP)
- Vite plugin integration
- Error handling and validation

### Domain Module Documentation

**Packages:**
- `@happyvertical/smrt-agents` - Agent framework
- `@happyvertical/smrt-content` - Content processing
- `@happyvertical/smrt-places` - Place management
- `@happyvertical/smrt-events` - Event management
- `@happyvertical/smrt-products` - Product catalog
- And more...

**Topics:**
- Domain-specific patterns
- Integration examples
- Best practices per domain

### Guide Documentation

**Available Guides:**
- Getting Started with SMRT
- Building Your First SMRT Application
- Advanced Querying and Relationships
- AI-Powered Operations
- MCP Server Generation
- Performance Optimization
- Testing SMRT Applications
- Deployment Strategies

## Development Workflow Integration

### Typical Learning Flow

1. **Initial Learning** (explain-concept)
   - Understand core framework concepts
   - Learn architectural patterns
   - Explore three-tier MCP architecture

2. **Pattern Discovery** (search-docs)
   - Find relevant documentation for specific tasks
   - Discover available features and APIs
   - Understand best practices

3. **Implementation Reference** (get-example)
   - Retrieve code examples for patterns
   - Copy-paste starting points
   - Verify correct usage

4. **Development** (Tier 2 Tools)
   - Generate SMRT classes
   - Introspect project structure
   - Implement business logic

5. **Runtime Integration** (Tier 1 MCP)
   - Generate project MCP server
   - Deploy AI-powered operations

### Example AI Conversation

```
User: "I'm new to SMRT. Where should I start?"

AI: Let me explain the core concepts.
    [Calls explain-concept for "SMRT framework overview"]

    The SMRT framework is built around three main concepts:
    1. SmrtObject - Persistent objects with AI capabilities
    2. SmrtCollection - Object management with querying
    3. Code Generation - Automatic API/CLI/MCP generation

User: "How do I define relationships between objects?"

AI: Let me search the documentation.
    [Calls search-docs for "relationships"]

    There are three types of relationships:
    - foreignKey: One-to-one or many-to-one
    - oneToMany: One-to-many
    - manyToMany: Many-to-many

User: "Show me an example of a foreign key relationship"

AI: Here's a complete example.
    [Calls get-example for "foreign key relationship"]

    [Returns code example with Product -> Category relationship]
```

## Three-Tier Context

**Tier 3's Role in the Ecosystem:**

```
Learning and Development Workflow:

1. Learn Framework Concepts
   └─► Tier 3 (smrt-docs-mcp)
       explain-concept, search-docs

2. Find Implementation Patterns
   └─► Tier 3 (smrt-docs-mcp)
       get-example, search-docs

3. Discover Project Structure
   └─► Tier 2 (smrt-dev-mcp)
       introspect-project

4. Generate Boilerplate
   └─► Tier 2 (smrt-dev-mcp)
       generate-smrt-class

5. Implement Business Logic
   └─► Manual Development
       Add custom methods and logic

6. Deploy MCP Server
   └─► Tier 1 (Generated Project MCP)
       Runtime AI integration

7. Operate Application
   └─► Tier 1 (Generated Project MCP)
       AI interacts with live data
```

**Related Documentation:**
- **Tier 1 MCP Architecture** - See [packages/core/CLAUDE.md](../core/CLAUDE.md#mcp-server-architecture-tier-1)
- **Tier 2 Development MCP** - See [packages/smrt-dev-mcp/CLAUDE.md](../smrt-dev-mcp/CLAUDE.md)
- **Overview** - See [root CLAUDE.md](../../CLAUDE.md#mcp-server-integration)

## Troubleshooting

### Tool Not Responding

**Issue**: MCP tools don't appear in Claude Desktop

**Solution**:
1. Verify configuration in `claude_desktop_config.json`
2. Restart Claude Desktop completely (Quit and reopen)
3. Check Claude Desktop logs for errors:
   - macOS: `~/Library/Logs/Claude/mcp*.log`
   - Windows: `%APPDATA%\Claude\logs\mcp*.log`

### Search Returns No Results

**Issue**: search-docs returns empty or irrelevant results

**Solution**:
1. Try broader search terms
2. Use concept-based queries instead of specific code
3. Check spelling of technical terms
4. Use explain-concept for overview, then search for specifics

### Example Not Found

**Issue**: get-example doesn't find the requested pattern

**Solution**:
1. Use search-docs to discover available examples
2. Try alternative pattern descriptions
3. Check if the pattern is documented in a different category
4. Use explain-concept to understand the broader concept first

## Documentation Structure

### Documentation Sources

The smrt-docs-mcp server aggregates documentation from:

1. **Package CLAUDE.md files**
   - Core framework documentation
   - Domain module documentation
   - Package-specific guides

2. **Root CLAUDE.md**
   - Monorepo-wide concepts
   - Development workflows
   - Cross-package integration

3. **README files**
   - Quick start guides
   - Installation instructions
   - Package overviews

4. **Code Examples**
   - Test files with real-world usage
   - Example applications
   - Pattern demonstrations

### Documentation Organization

**By Topic:**
- Core Concepts
- API Reference
- Guides and Tutorials
- Code Examples
- Best Practices
- Troubleshooting

**By Package:**
- Framework Core (`@happyvertical/smrt-core`)
- Domain Modules (agents, content, places, events, etc.)
- Development Tools (smrt-dev-mcp)
- Configuration (smrt-config)

**By Experience Level:**
- Getting Started (beginner)
- Common Patterns (intermediate)
- Advanced Topics (advanced)
- Expert Techniques (expert)

## Development Guidelines

### When to Use Tier 3

**✅ Use Tier 3 For:**
- Learning SMRT framework concepts
- Looking up API documentation
- Finding implementation examples
- Understanding architectural decisions
- Troubleshooting issues
- Discovering available features

**❌ Don't Use Tier 3 For:**
- Generating code (use Tier 2)
- Inspecting project structure (use Tier 2)
- Runtime operations (use Tier 1)
- Modifying documentation (manual editing)

### Documentation Quality

**Maintained Documentation:**
- Core framework patterns
- Essential guides and examples
- API reference for all packages
- Common troubleshooting scenarios

**Community Contributions:**
- Advanced use cases
- Integration examples
- Domain-specific patterns
- Best practices from experience

## Version History

- **v0.1.0** - Initial release with search-docs, get-example, and explain-concept tools
- Package follows semantic versioning

## Contributing

For issues, feature requests, or contributions:
- **GitHub**: https://github.com/happyvertical/smrt/issues
- **Package Directory**: `packages/smrt-docs-mcp/`
- **Documentation Improvements**: Submit PRs to update CLAUDE.md files

## License

MIT License - See [LICENSE](../../LICENSE) for details
