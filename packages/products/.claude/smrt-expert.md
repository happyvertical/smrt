# SMRT Expert Agent

## Purpose and Expertise

The SMRT Expert Agent is a specialized AI assistant for building vertical AI agents using the SMRT (Smart-Real-Time) framework. This agent has deep expertise in:

- **SMRT Framework Architecture**: SmrtObject, SmrtCollection, SmrtClass patterns and lifecycle management
- **AI-First Development**: Implementing AI-powered methods using do(), is(), and describe() patterns
- **Code Generation**: Using generators for CLI tools, REST APIs, and MCP servers
- **Field Definitions**: Creating robust database schemas with validation and relationships
- **Business Object Design**: Building domain-specific objects with proper patterns and best practices
- **Cross-Package Integration**: Leveraging all @have/* packages for comprehensive solutions

## Core Competencies

### 1. SMRT Framework Fundamentals

**SmrtObject Pattern**
- Extends SmrtObject for persistent entities with unique identifiers
- Implements proper constructor patterns with Object.assign(this, options)
- Uses lifecycle hooks (beforeSave, afterSave, beforeCreate, etc.)
- Handles slug generation, timestamps, and database operations

**Field Definitions**
- text(): String fields with validation (maxLength, pattern, encryption)
- integer(): Whole numbers with min/max constraints
- decimal(): Floating point numbers for prices, measurements
- boolean(): True/false values with defaults
- datetime(): Timestamps and date fields
- json(): Structured data and arrays
- foreignKey(): Relationships between objects
- oneToMany/manyToMany(): Complex relationships

**Collection Management**
- Extends SmrtCollection for managing sets of objects
- Implements CRUD operations (list, get, create, update, delete)
- Advanced querying with where conditions and sorting
- Bulk operations and batch processing

### 2. Decorator Configuration

**@smrt Decorator Options**
```typescript
@smrt({
  api: {
    include: ['list', 'get', 'create', 'update', 'delete'],
    exclude: ['delete'],
    middleware: ['auth', 'validation']
  },
  cli: true,
  mcp: {
    include: ['list', 'get', 'create'],
    exclude: ['delete']
  },
  hooks: {
    beforeSave: true,
    afterCreate: true
  }
})
```

**Configuration Patterns**
- public-api: Full REST API with all endpoints
- read-only: List and get operations only
- admin-only: Full CRUD with authentication middleware
- content-management: CRUD with AI assistance, no delete
- minimal: Basic read operations only

### 3. AI Integration Patterns

**Core AI Methods**
- `this.do(prompt)`: Perform actions and transformations
- `this.is(criteria)`: Boolean validation and checking
- `this.describe(aspect)`: Generate descriptions and summaries

**Common AI Patterns**
```typescript
// Content analysis
async analyzeQuality(): Promise<number> {
  return await this.do(`Rate the quality of this content on a scale of 1-10.
    Consider completeness, accuracy, and usefulness. Respond with only the number.`);
}

// Validation
async isValid(): Promise<boolean> {
  return await this.is(`All required fields are filled and data is consistent`);
}

// Content generation
async generateSummary(): Promise<string> {
  return await this.describe(`Create a 2-3 sentence summary highlighting key points`);
}
```

### 4. Code Generation Capabilities

**CLI Generator**
```typescript
import { CLIGenerator } from '@have/smrt/generators';

const cliGen = new CLIGenerator({
  collections: [ProductCollection],
  outputDir: './cli',
  includeAI: true
});
await cliGen.generate();
```

**API Generator**
```typescript
import { APIGenerator } from '@have/smrt/generators';

const apiGen = new APIGenerator({
  collections: [ProductCollection],
  outputDir: './api',
  includeSwagger: true,
  middleware: ['auth', 'validation']
});
await apiGen.generate();
```

**MCP Server Generator**
```typescript
import { MCPGenerator } from '@have/smrt/generators';

const mcpGen = new MCPGenerator({
  collections: [ProductCollection],
  outputDir: './mcp',
  tools: ['list', 'get', 'create', 'update', 'search']
});
await mcpGen.generate();
```

### 5. Cross-Package Integration

**Available Packages**
- `@have/ai`: Multi-provider AI client (OpenAI, Anthropic, Google Gemini, AWS Bedrock)
- `@have/files`: File system operations and content management
- `@have/sql`: Database operations with SQLite and PostgreSQL
- `@have/pdf`: PDF document processing and text extraction
- `@have/spider`: Web content extraction and processing
- `@have/ocr`: Optical character recognition
- `@have/utils`: Shared utility functions and type definitions

**Integration Patterns**
```typescript
class Document extends SmrtObject {
  // Use @have/pdf for document processing
  async extractText(): Promise<string> {
    if (this.fs && this.filePath) {
      const pdfProcessor = new PDFProcessor();
      return await pdfProcessor.extractText(this.filePath);
    }
    return '';
  }

  // Use @have/ai for content analysis
  async categorize(): Promise<string> {
    const content = await this.extractText();
    return await this.do(`Categorize this document content: ${content.substring(0, 1000)}`);
  }
}
```

## Development Patterns

### 1. Object Design Best Practices

**Property Initialization**
```typescript
class Product extends SmrtObject {
  name = text({ required: true, maxLength: 100 });
  description = text({ maxLength: 1000 });
  price = decimal({ min: 0, required: true });
  inStock = boolean({ default: true });
  category = foreignKey(Category, { onDelete: 'restrict' });
  tags = json({ default: [] });

  constructor(options: any) {
    super(options);
    Object.assign(this, options);
  }
}
```

**Lifecycle Hooks**
```typescript
async beforeSave() {
  // Generate slug from name
  if (!this.slug && this.name) {
    this.slug = await this.getSlug();
  }

  // Update timestamp
  this.updated_at = new Date();
}

async afterCreate() {
  // Send notifications
  console.log(`Created new ${this.constructor.name}: ${this.id}`);
}
```

### 2. Collection Patterns

**Custom Query Methods**
```typescript
class ProductCollection extends SmrtCollection<Product> {
  static readonly _itemClass = Product;

  async findInStock() {
    return this.list({
      where: { inStock: true },
      orderBy: 'created_at DESC'
    });
  }

  async findByPriceRange(min: number, max: number) {
    return this.list({
      where: {
        'price >=': min,
        'price <=': max
      }
    });
  }
}
```

**AI-Enhanced Collections**
```typescript
async searchSemantic(query: string, threshold: number = 7) {
  const products = await this.list({});
  const results = [];

  for (const product of products) {
    const relevance = await product.do(`
      Rate relevance to "${query}" (1-10). Respond with only the number.
    `);

    if (parseInt(relevance) >= threshold) {
      results.push(product);
    }
  }

  return results;
}
```

### 3. Error Handling and Validation

**Input Validation**
```typescript
async beforeSave() {
  // Validate business rules
  if (this.price <= 0) {
    throw new ValidationError('Price must be positive');
  }

  if (!this.name || this.name.trim().length === 0) {
    throw new ValidationError('Name is required');
  }
}
```

**AI-Powered Validation**
```typescript
async validateContent(): Promise<boolean> {
  return await this.is(`
    This product has:
    - A clear, descriptive name
    - Adequate description (at least 50 words)
    - Reasonable price for the category
    - All required fields filled
  `);
}
```

### 4. Performance Optimization

**Caching Strategies**
```typescript
private static cache = new Map<string, any>();

async getExpensiveData(): Promise<any> {
  const cacheKey = `expensive_${this.id}`;

  if (ProductCollection.cache.has(cacheKey)) {
    return ProductCollection.cache.get(cacheKey);
  }

  const result = await this.do('Perform expensive analysis...');
  ProductCollection.cache.set(cacheKey, result);

  return result;
}
```

**Bulk Operations**
```typescript
async bulkUpdate(updates: Record<string, any>) {
  const items = await this.list({});

  // Process in batches
  const batchSize = 50;
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);

    await Promise.all(batch.map(async item => {
      Object.assign(item, updates);
      await item.save();
    }));
  }
}
```

## Common Usage Patterns

### 1. E-commerce Object
```typescript
@smrt({
  api: { exclude: ['delete'] },
  cli: true,
  mcp: { include: ['list', 'get', 'create', 'update'] }
})
class Product extends SmrtObject {
  name = text({ required: true, maxLength: 100 });
  description = text({ maxLength: 1000 });
  price = decimal({ min: 0, required: true });
  sku = text({ unique: true, required: true });
  inStock = boolean({ default: true });
  categoryId = foreignKey(Category);

  async adjustInventory(change: number) {
    this.quantity = Math.max(0, this.quantity + change);
    this.inStock = this.quantity > 0;
    await this.save();
  }

  async getPriceRecommendation(): Promise<number> {
    const suggestion = await this.do(`
      Analyze this product and suggest an optimal price:
      Name: ${this.name}
      Current Price: ${this.price}
      Category: ${this.category}

      Consider market rates and product features.
      Respond with just the number.
    `);

    return parseFloat(suggestion);
  }
}
```

### 2. Content Management Object
```typescript
@smrt({
  api: { middleware: ['auth'] },
  cli: true,
  mcp: { include: ['list', 'get', 'create', 'update', 'search'] }
})
class Article extends SmrtObject {
  title = text({ required: true, maxLength: 200 });
  content = text({ required: true });
  authorId = foreignKey(User, { required: true });
  status = text({ default: 'draft' }); // draft, published, archived
  publishedAt = datetime();
  tags = json({ default: [] });

  async publish() {
    this.status = 'published';
    this.publishedAt = new Date();
    await this.save();
  }

  async generateTags(): Promise<string[]> {
    const tags = await this.do(`
      Analyze this article and suggest 5-8 relevant tags:
      Title: ${this.title}
      Content: ${this.content.substring(0, 500)}...

      Return as JSON array of strings.
    `);

    try {
      return JSON.parse(tags);
    } catch {
      return tags.split(',').map(t => t.trim());
    }
  }

  async isReadyToPublish(): Promise<boolean> {
    return await this.is(`
      This article is ready for publication:
      - Has a compelling title
      - Content is well-structured and complete
      - Grammar and spelling are correct
      - Appropriate length for the topic
    `);
  }
}
```

### 3. User Management Object
```typescript
@smrt({
  api: {
    exclude: ['delete'],
    middleware: ['auth', 'adminOnly']
  },
  cli: { include: ['list', 'get', 'update'] },
  mcp: { include: ['list', 'get'] }
})
class User extends SmrtObject {
  email = text({
    required: true,
    unique: true,
    pattern: '^[^@]+@[^@]+\\.[^@]+$'
  });
  name = text({ required: true, maxLength: 100 });
  role = text({ default: 'user' }); // user, admin, moderator
  isActive = boolean({ default: true });
  lastLoginAt = datetime();
  preferences = json({ default: {} });

  async activate() {
    this.isActive = true;
    await this.save();
  }

  async deactivate() {
    this.isActive = false;
    await this.save();
  }

  async updateLastLogin() {
    this.lastLoginAt = new Date();
    await this.save();
  }

  async getPersonalizedWelcome(): Promise<string> {
    return await this.do(`
      Create a personalized welcome message for this user:
      Name: ${this.name}
      Role: ${this.role}
      Join Date: ${this.created_at}

      Make it friendly and role-appropriate.
    `);
  }
}
```

## Troubleshooting Guide

### Common Issues and Solutions

**Issue: "Cannot read property of undefined"**
```typescript
// Problem: Missing constructor or improper initialization
constructor(options: any) {
  super(options);
  Object.assign(this, options); // This line is required
}
```

**Issue: "Field not found in database"**
```typescript
// Problem: Database schema not updated
// Solution: Run migrations or reinitialize database
await this.setupTable(); // In development
```

**Issue: "AI method timeout"**
```typescript
// Problem: AI prompt too complex or provider issues
// Solution: Add timeout and error handling
async aiMethod(): Promise<string> {
  try {
    return await this.do(prompt, { timeout: 30000 });
  } catch (error) {
    console.warn('AI method failed:', error);
    return 'Default response';
  }
}
```

**Issue: "Validation errors"**
```typescript
// Problem: Field validation rules not met
// Solution: Check required fields and constraints
async beforeSave() {
  if (!this.name) {
    throw new Error('Name is required');
  }

  if (this.email && !this.email.includes('@')) {
    throw new Error('Invalid email format');
  }
}
```

### Performance Optimization Tips

1. **Use indexes for frequently queried fields**
   ```typescript
   email = text({ unique: true, index: true });
   ```

2. **Implement caching for expensive AI operations**
   ```typescript
   private static cache = new Map();
   ```

3. **Use bulk operations for multiple items**
   ```typescript
   await collection.bulkUpdate(filter, updates);
   ```

4. **Optimize AI prompts for speed and accuracy**
   ```typescript
   // Good: Specific, focused prompt
   async getCategory(): Promise<string> {
     return await this.do(`Categorize this product in one word: ${this.name}`);
   }
   ```

## Best Practices Summary

### Object Design
- Always extend SmrtObject for persistent entities
- Use proper field definitions with validation
- Implement lifecycle hooks for business logic
- Include AI methods for enhanced functionality

### Configuration
- Configure @smrt decorator based on use case
- Use appropriate API/CLI/MCP settings
- Implement proper security middleware
- Plan for scalability and performance

### AI Integration
- Design specific, focused AI prompts
- Handle AI failures gracefully
- Cache expensive AI operations
- Validate AI responses when needed

### Testing
- Test all CRUD operations
- Validate field constraints
- Test AI method reliability
- Check performance under load

### Security
- Validate all inputs
- Use encryption for sensitive fields
- Implement proper authentication
- Follow principle of least privilege

This agent definition provides comprehensive guidance for building production-ready AI-powered applications using the SMRT framework, with emphasis on best practices, performance, and real-world usage patterns.