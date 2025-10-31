# @happyvertical/smrt-dev-mcp: SMRT Advisor MCP (Tier 2)

## Purpose and Responsibilities

The SMRT Advisor MCP is a **development-focused MCP server** for code generation and project introspection. It provides AI-powered tools to accelerate SMRT framework development by generating boilerplate code, discovering project structure, and providing intelligent assistance during the development workflow.

**Tier 2 Position in MCP Architecture:**
- **Tier 1 (Runtime)**: Auto-generated project MCP servers for application data and operations
- **Tier 2 (Development)**: 👈 **You are here** - Code generation and project introspection tools
- **Tier 3 (Documentation)**: Framework knowledge and documentation access

## Installation

### NPX (Recommended for Ad-Hoc Usage)

```bash
# Run directly without installation
npx -y @happyvertical/smrt-dev-mcp
```

### Claude Desktop Integration

Add to your Claude Desktop configuration (`~/Library/Application\ Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "smrt-dev-mcp": {
      "command": "npx",
      "args": ["-y", "@happyvertical/smrt-dev-mcp"]
    }
  }
}
```

After adding, restart Claude Desktop to activate the MCP server.

### Global Installation (Optional)

```bash
npm install -g @happyvertical/smrt-dev-mcp

# Then use in Claude Desktop config:
{
  "mcpServers": {
    "smrt-dev-mcp": {
      "command": "smrt-dev-mcp"
    }
  }
}
```

## Available Tools

### 1. generate-smrt-class

Generates complete SMRT class code with the `@smrt()` decorator, field definitions, and optional configuration for API, MCP, and CLI.

**Input Parameters:**
```typescript
{
  className: string;              // Class name (PascalCase)
  baseClass?: string;             // Base class: 'SmrtObject' or 'SmrtCollection' (default: 'SmrtObject')
  properties: Array<{
    name: string;                 // Property name (camelCase)
    type: string;                 // Field type: 'text', 'integer', 'decimal', 'boolean', 'datetime', 'json'
    required?: boolean;           // NOT NULL constraint
    description?: string;         // Field documentation
  }>;
  includeApiConfig?: boolean;     // Generate REST API configuration (default: true)
  includeMcpConfig?: boolean;     // Generate MCP server configuration (default: true)
  includeCliConfig?: boolean;     // Generate CLI configuration (default: true)
}
```

**Output:**

Complete TypeScript class with:
- Import statements
- `@smrt()` decorator with configuration
- Field definitions using Field helpers
- Optional custom methods structure
- JSDoc documentation

**Example Usage:**

```typescript
// Input
{
  className: "Product",
  properties: [
    { name: "name", type: "text", required: true, description: "Product name" },
    { name: "price", type: "decimal", required: true, description: "Product price in USD" },
    { name: "active", type: "boolean", description: "Product availability status" }
  ],
  includeApiConfig: true,
  includeMcpConfig: true,
  includeCliConfig: true
}

// Generated Output
import { SmrtObject } from '@happyvertical/smrt-core';
import { smrt } from '@happyvertical/smrt-core';
import { text, decimal, boolean } from '@happyvertical/smrt-core/fields';

@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get'] },
  cli: true
})
class Product extends SmrtObject {
  /** Product name */
  name = text({ required: true });

  /** Product price in USD */
  price = decimal({ required: true });

  /** Product availability status */
  active = boolean({ default: true });

  // Add custom methods here
}

export default Product;
```

**Use Cases:**
- Rapidly prototype new SMRT objects during development
- Generate boilerplate code for domain models
- Ensure consistent class structure across the project
- Reduce manual typing errors in field definitions

### 2. introspect-project

Scans a project directory for SMRT objects, analyzes their structure, and returns a comprehensive report of discovered classes, fields, methods, and relationships.

**Input Parameters:**
```typescript
{
  directory?: string;              // Project directory (default: current working directory)
  includeFields?: boolean;         // Include field details (default: true)
  includeRelationships?: boolean;  // Analyze relationships (default: false)
}
```

**Output:**

JSON report with:
- Project path
- Total object count
- List of discovered objects with:
  - Class name
  - File path
  - Fields summary
  - Methods summary
  - Relationships (if enabled)

**Example Usage:**

```typescript
// Input
{
  directory: "./src/models",
  includeFields: true,
  includeRelationships: true
}

// Output
{
  projectPath: "/path/to/project/src/models",
  objectCount: 3,
  objects: [
    {
      className: "Product",
      filePath: "src/models/product.ts",
      fields: "name: text (required), price: decimal (required), active: boolean",
      methods: "async analyze(options: any), async getRelatedProducts()",
      relationships: "categoryId -> Category (foreignKey)"
    },
    {
      className: "Category",
      filePath: "src/models/category.ts",
      fields: "name: text (required), description: text",
      methods: "async getProducts()",
      relationships: "products <- Product (oneToMany)"
    },
    {
      className: "Order",
      filePath: "src/models/order.ts",
      fields: "customerId: text (required), productId: text (required), quantity: integer",
      methods: "async calculateTotal()",
      relationships: "customerId -> Customer (foreignKey), productId -> Product (foreignKey)"
    }
  ]
}
```

**Use Cases:**
- Understand existing project structure
- Generate project documentation automatically
- Identify relationships between objects
- Audit field definitions and method signatures
- Provide AI context for codebase exploration
- Plan refactoring or feature additions

## Development Workflow Integration

### Typical AI-Assisted Development Flow

1. **Discovery Phase** (introspect-project)
   - Analyze existing codebase structure
   - Identify similar objects for reference
   - Understand relationship patterns

2. **Generation Phase** (generate-smrt-class)
   - Generate new SMRT object scaffolding
   - Ensure consistent structure and conventions
   - Include appropriate API/MCP/CLI configuration

3. **Implementation Phase** (Manual Development)
   - Add custom business logic
   - Implement domain-specific methods
   - Write tests and documentation

4. **Deployment Phase** (Tier 1 MCP Generation)
   - Generate project-specific MCP server
   - Deploy runtime MCP tools for AI integration

### Example AI Conversation

```
User: "I want to add a new Product class to my e-commerce project"

AI: Let me first introspect your project to understand the existing structure.
    [Calls introspect-project tool]

    I see you have Customer and Order classes. I'll generate a Product class
    that follows your existing patterns and relationships.
    [Calls generate-smrt-class tool]

    Here's the generated Product class. You'll want to add these custom methods:
    - async analyze() for product analytics
    - async getRelatedProducts() for recommendations

User: "Great! Now generate the MCP server"

AI: Now that your objects are defined, generate the Tier 1 MCP server:
    [Uses npx smrt generate-mcp or provides instructions]
```

## Tool Configuration

### generate-smrt-class Configuration

**Field Types:**
- `text` - TEXT column with optional maxLength, minLength, pattern validation
- `integer` - INTEGER column with optional min/max constraints
- `decimal` - REAL column for floating point numbers
- `boolean` - INTEGER column (0/1) for boolean values
- `datetime` - DATETIME column for timestamps
- `json` - TEXT column with JSON serialization

**Configuration Options:**
- `includeApiConfig: true` - Generate REST API endpoints (list, get, create, update, delete)
- `includeMcpConfig: true` - Generate MCP tools for AI integration
- `includeCliConfig: true` - Generate CLI commands for administrative tasks

**Best Practices:**
- Use `required: true` for essential fields
- Add `description` for better documentation
- Keep property names in camelCase
- Use appropriate field types for validation

### introspect-project Configuration

**Directory Scanning:**
- Recursively scans TypeScript files
- Detects classes extending SmrtObject or SmrtCollection
- Analyzes AST for field definitions and methods

**Relationship Detection:**
- `foreignKey` relationships (belongs-to)
- `oneToMany` relationships (has-many)
- `manyToMany` relationships (many-to-many)

**Output Format:**
- Human-readable summaries for AI consumption
- Structured JSON for programmatic processing

## Three-Tier Context

**Tier 2's Role in the Ecosystem:**

```
Development Workflow:

1. Learn Framework
   └─► Tier 3 (smrt-docs-mcp)
       Query documentation and examples

2. Discover Project Structure
   └─► Tier 2 (smrt-dev-mcp)
       Introspect existing codebase

3. Generate Boilerplate
   └─► Tier 2 (smrt-dev-mcp)
       Generate SMRT classes

4. Implement Business Logic
   └─► Manual Development
       Add custom methods and logic

5. Deploy MCP Server
   └─► Tier 1 (Generated Project MCP)
       Runtime AI integration

6. Operate Application
   └─► Tier 1 (Generated Project MCP)
       AI interacts with live data
```

**Related Documentation:**
- **Tier 1 MCP Architecture** - See [packages/core/CLAUDE.md](../core/CLAUDE.md#mcp-server-architecture-tier-1)
- **Tier 3 Documentation MCP** - See [packages/smrt-docs-mcp/CLAUDE.md](../smrt-docs-mcp/CLAUDE.md)
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

### NPX Version Issues

**Issue**: `npx -y @happyvertical/smrt-dev-mcp` fails

**Solution**:
1. Update npm: `npm install -g npm@latest`
2. Clear npx cache: `rm -rf ~/.npm/_npx`
3. Try explicit version: `npx -y @happyvertical/smrt-dev-mcp@latest`

### Generation Errors

**Issue**: generate-smrt-class produces invalid code

**Solution**:
1. Verify field types are valid (text, integer, decimal, boolean, datetime, json)
2. Ensure property names are valid JavaScript identifiers
3. Check className is PascalCase
4. Validate JSON input structure

### Introspection Returns Empty

**Issue**: introspect-project finds no objects

**Solution**:
1. Verify directory path is correct
2. Ensure files use `@smrt()` decorator or extend SmrtObject
3. Check file extensions are `.ts` or `.tsx`
4. Confirm project has been built (if using compiled output)

## Development Guidelines

### When to Use Tier 2

**✅ Use Tier 2 For:**
- Generating new SMRT objects during development
- Understanding existing project structure
- Creating consistent boilerplate code
- AI-assisted development workflows
- Project auditing and documentation

**❌ Don't Use Tier 2 For:**
- Production runtime operations (use Tier 1)
- Accessing live application data (use Tier 1)
- Framework documentation lookup (use Tier 3)
- Modifying existing code directly (manual editing recommended)

### Security Considerations

**Safe Operations:**
- Reading project structure and metadata
- Generating code based on input parameters
- Analyzing AST without execution

**Not Performed:**
- Writing files to disk automatically
- Executing generated code
- Modifying existing files
- Accessing sensitive data

**Best Practice**: Review generated code before committing to version control.

## Version History

- **v0.1.0** - Initial release with generate-smrt-class and introspect-project tools
- Package follows semantic versioning

## Contributing

For issues, feature requests, or contributions:
- **GitHub**: https://github.com/happyvertical/smrt/issues
- **Package Directory**: `packages/smrt-dev-mcp/`

## License

MIT License - See [LICENSE](../../LICENSE) for details
