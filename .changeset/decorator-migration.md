---
'@happyvertical/smrt-core': minor
'@happyvertical/smrt-profiles': minor
'@happyvertical/smrt-places': minor
'@happyvertical/smrt-events': minor
'@happyvertical/smrt-tags': minor
'@happyvertical/smrt-content': minor
---

# BREAKING: Decorator Migration - Field Helpers Removed

This release introduces `@field()` decorators as the **only** pattern for defining SMRT object properties. **Field helper functions have been completely removed** from the codebase.

## ✨ New Features

### Property Decorators
```typescript
import { SmrtObject, smrt, field } from '@happyvertical/smrt-core';

@smrt()
class Product extends SmrtObject {
  // Decorator for constrained fields
  @field({ required: true })
  name: string = '';

  // TypeScript types for simple fields
  description: string = '';
  price: number = 0.0;      // DECIMAL (has decimal point)
  quantity: number = 0;     // INTEGER (no decimal point)
  active: boolean = true;
  tags: string[] = [];
  createdAt: Date = new Date();
}
```

### Benefits
- **Better IDE Support**: Full IntelliSense and type checking
- **Cleaner Syntax**: More readable and maintainable code
- **TypeScript-First**: Leverages native TypeScript types
- **Automatic Schema Generation**: AST scanner infers database types from TypeScript

## 🔄 Changes

### All Domain Packages Migrated
- **@happyvertical/smrt-profiles**: All models now use decorators
- **@happyvertical/smrt-places**: Migrated to decorators
- **@happyvertical/smrt-events**: EventType and related models updated
- **@happyvertical/smrt-tags**: Tag and TagAlias migrated
- **@happyvertical/smrt-content**: Content model updated

### MCP Code Generators Updated
- `generate-smrt-class` tool now generates decorator-based code by default
- `generate-field-definitions` tool updated to use decorators
- All generated code follows modern TypeScript patterns

### Core Improvements
- AST scanner automatically marks `oneToMany`/`manyToMany` fields as transient
- Optimized object initialization for decorator-based classes
- Added `ObjectRegistry.hasFieldDecorators()` helper method

## 📚 Migration Guide

### Before (Field Helpers)
```typescript
import { SmrtObject, smrt, text, integer, decimal } from '@happyvertical/smrt-core';

@smrt()
class Product extends SmrtObject {
  name = text({ required: true });
  quantity = integer();
  price = decimal();
}
```

### After (Decorators)
```typescript
import { SmrtObject, smrt, field } from '@happyvertical/smrt-core';

@smrt()
class Product extends SmrtObject {
  @field({ required: true })
  name: string = '';

  quantity: number = 0;      // INTEGER
  price: number = 0.0;       // DECIMAL
}
```

## 💥 BREAKING CHANGES

**Field helpers have been completely removed:**
- ❌ `text()`, `integer()`, `decimal()`, `boolean()`, `datetime()`, `json()` - DELETED
- ❌ `import { text } from '@happyvertical/smrt-core/fields'` - Will throw error
- ✅ Use `@field()` decorator or plain TypeScript properties instead

**Why this is better:**
- 🧹 **Cleaner codebase** - Removed 20KB+ of legacy code
- 🚀 **Better performance** - No Field instance overhead
- 🤖 **AI-friendly** - Less noise, clearer patterns for agentic coders
- 📚 **Simpler mental model** - One way to define fields, not two

## 📖 Documentation

All framework documentation has been updated to show decorators as the primary pattern, with field helpers documented as a legacy alternative.

See [CLAUDE.md](./CLAUDE.md) for complete migration guide and best practices.
