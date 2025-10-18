# Function: integer()

> **integer**(`options`): [`Field`](../classes/Field.md)

Defined in: [smrt/packages/core/src/fields/index.ts:308](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/fields/index.ts#L308)

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
