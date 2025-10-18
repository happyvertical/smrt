# Function: json()

> **json**(`options`): [`Field`](../classes/Field.md)

Defined in: [smrt/packages/core/src/fields/index.ts:380](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/fields/index.ts#L380)

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
