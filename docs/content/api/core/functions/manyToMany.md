# Function: manyToMany()

> **manyToMany**(`relatedClass`, `options`): [`Field`](../classes/Field.md)

Defined in: smrt/packages/core/src/fields/index.ts:530

Creates a many-to-many relationship field

Supports lazy string-based references to avoid circular dependencies:
- String: `manyToMany('Category')` - Recommended, avoids circular deps
- Function: `manyToMany(() => Category)` - Lazy evaluation
- Class: `manyToMany(Category)` - Direct reference (legacy, can cause circular deps)

## Parameters

### relatedClass

`any`

String name, lazy function, or class constructor of the related objects

### options

`Omit`\<[`RelationshipFieldOptions`](../interfaces/RelationshipFieldOptions.md), `"related"`\> = `{}`

Configuration options for the relationship

## Returns

[`Field`](../classes/Field.md)

Field instance configured for many-to-many relationships

## Example

```typescript
class Product extends SmrtObject {
  // Recommended: Lazy string references
  categories = manyToMany('Category');
  tags = manyToMany('Tag');
}

class User extends SmrtObject {
  roles = manyToMany('Role');
}
```
