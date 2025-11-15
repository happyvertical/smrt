# Function: boolean()

> **boolean**(`options`): [`Field`](../classes/Field.md)

Defined in: [packages/core/src/fields/index.ts:405](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/fields/index.ts#L405)

Creates a boolean field for storing true/false values

## Parameters

### options

[`FieldOptions`](../interfaces/FieldOptions.md) = `{}`

Configuration options for the boolean field

## Returns

[`Field`](../classes/Field.md)

Field instance configured for boolean storage

## Example

```typescript
class User extends SmrtObject {
  isActive = boolean({ default: true });
  hasVerifiedEmail = boolean({ default: false });
  isAdmin = boolean({ required: true });
}
```
