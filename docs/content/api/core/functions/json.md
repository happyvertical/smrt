# Function: json()

> **json**(`options`): [`Field`](../classes/Field.md)

Defined in: [packages/core/src/fields/index.ts:441](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/fields/index.ts#L441)

Creates a JSON field for storing structured data objects

## Parameters

### options

[`FieldOptions`](../interfaces/FieldOptions.md) = `{}`

Configuration options for the JSON field

## Returns

[`Field`](../classes/Field.md)

Field instance configured for JSON storage

## Example

```typescript
class User extends SmrtObject {
  preferences = json({ default: {} });
  metadata = json();
  config = json({ required: true });
}
```
