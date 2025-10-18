# Function: text()

> **text**(`options`): [`Field`](../classes/Field.md)

Defined in: smrt/packages/core/src/fields/index.ts:290

Creates a text field for storing string values

## Parameters

### options

[`TextFieldOptions`](../interfaces/TextFieldOptions.md) = `{}`

Configuration options for the text field

## Returns

[`Field`](../classes/Field.md)

Field instance configured for text storage

## Example

```typescript
class User extends SmrtObject {
  name = text({ required: true, maxLength: 100 });
  email = text({ unique: true, pattern: '^[^@]+@[^@]+\.[^@]+$' });
  bio = text({ maxLength: 500 });
}
```
