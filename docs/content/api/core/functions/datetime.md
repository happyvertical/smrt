# Function: datetime()

> **datetime**(`options`): [`Field`](../classes/Field.md)

Defined in: [smrt/packages/core/src/fields/index.ts:362](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/fields/index.ts#L362)

Creates a datetime field for storing timestamps

## Parameters

### options

[`FieldOptions`](../interfaces/FieldOptions.md) = `{}`

Configuration options for the datetime field

## Returns

[`Field`](../classes/Field.md)

Field instance configured for datetime storage

## Example

```typescript
class Event extends SmrtObject {
  startDate = datetime({ required: true });
  endDate = datetime();
  createdAt = datetime({ default: new Date() });
}
```
