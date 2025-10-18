# Function: oneToMany()

> **oneToMany**(`relatedClass`, `options`): [`Field`](../classes/Field.md)

Defined in: smrt/packages/core/src/fields/index.ts:474

Creates a one-to-many relationship field

Supports lazy string-based references to avoid circular dependencies:
- String: `oneToMany('Product')` - Recommended, avoids circular deps
- Function: `oneToMany(() => Product)` - Lazy evaluation
- Class: `oneToMany(Product)` - Direct reference (legacy, can cause circular deps)

## Parameters

### relatedClass

`any`

String name, lazy function, or class constructor of the related objects

### options

`Omit`\<[`RelationshipFieldOptions`](../interfaces/RelationshipFieldOptions.md), `"related"`\> = `{}`

Configuration options for the relationship

## Returns

[`Field`](../classes/Field.md)

Field instance configured for one-to-many relationships

## Example

```typescript
class Category extends SmrtObject {
  // Recommended: Lazy string reference
  products = oneToMany('Product');
}

class Customer extends SmrtObject {
  orders = oneToMany('Order', { onDelete: 'cascade' });
}
```
