# Function: decimal()

> **decimal**(`options`): [`Field`](../classes/Field.md)

Defined in: [smrt/packages/core/src/fields/index.ts:326](https://github.com/happyvertical/smrt/blob/bfd2feaea84273ee833a92e2d20c959aedfcfbd9/packages/core/src/fields/index.ts#L326)

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
