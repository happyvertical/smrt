# Function: json()

> **json**(`options`): [`Field`](../classes/Field.md)

Defined in: smrt/packages/core/src/fields/index.ts:380

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
