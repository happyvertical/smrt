# Function: integer()

> **integer**(`options`): [`Field`](../classes/Field.md)

Defined in: smrt/packages/core/src/fields/index.ts:308

Creates an integer field for storing whole numbers

## Parameters

### options

[`NumericFieldOptions`](../interfaces/NumericFieldOptions.md) = `{}`

Configuration options for the integer field

## Returns

[`Field`](../classes/Field.md)

Field instance configured for integer storage

## Example

```typescript
class Product extends SmrtObject {
  quantity = integer({ min: 0, required: true });
  rating = integer({ min: 1, max: 5 });
  views = integer({ default: 0 });
}
```
