# Function: decimal()

> **decimal**(`options`): [`Field`](../classes/Field.md)

Defined in: smrt/packages/core/src/fields/index.ts:326

Creates a decimal field for storing floating point numbers

## Parameters

### options

[`NumericFieldOptions`](../interfaces/NumericFieldOptions.md) = `{}`

Configuration options for the decimal field

## Returns

[`Field`](../classes/Field.md)

Field instance configured for decimal storage

## Example

```typescript
class Product extends SmrtObject {
  price = decimal({ min: 0, required: true });
  weight = decimal({ min: 0.01, max: 999.99 });
  discountRate = decimal({ min: 0, max: 1, default: 0 });
}
```
