# Function: boolean()

> **boolean**(`options`): [`Field`](../classes/Field.md)

Defined in: [smrt/packages/core/src/fields/index.ts:344](https://github.com/happyvertical/smrt/blob/bfd2feaea84273ee833a92e2d20c959aedfcfbd9/packages/core/src/fields/index.ts#L344)

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
