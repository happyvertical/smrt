# Function: foreignKey()

> **foreignKey**(`relatedClass`, `options`): [`Field`](../classes/Field.md)

Defined in: [packages/core/src/fields/index.ts:471](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/fields/index.ts#L471)

Creates a foreign key field that references another SMRT object

Supports lazy string-based references to avoid circular dependencies:
- String: `foreignKey('Customer')` - Recommended, avoids circular deps
- Function: `foreignKey(() => Customer)` - Lazy evaluation
- Class: `foreignKey(Customer)` - Direct reference (legacy, can cause circular deps)

## Parameters

### relatedClass

`any`

String name, lazy function, or class constructor of the related object

### options

`Omit`\<[`RelationshipFieldOptions`](../interfaces/RelationshipFieldOptions.md), `"related"`\> = `{}`

Configuration options for the foreign key field

## Returns

[`Field`](../classes/Field.md)

Field instance configured for foreign key relationships

## Example

```typescript
class Order extends SmrtObject {
  // Recommended: Lazy string reference (no circular dependency)
  customerId = foreignKey('Customer', { required: true, onDelete: 'restrict' });
  productId = foreignKey('Product', { onDelete: 'cascade' });

  // Alternative: Lazy function reference
  categoryId = foreignKey(() => Category, { required: true });

  // Legacy: Direct class reference (can cause circular dependency issues)
  // customerId = foreignKey(Customer, { required: true });
}
```
