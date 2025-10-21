# Function: datetime()

> **datetime**(`options`): [`Field`](../classes/Field.md)

Defined in: [smrt/packages/core/src/fields/index.ts:362](https://github.com/happyvertical/smrt/blob/bfd2feaea84273ee833a92e2d20c959aedfcfbd9/packages/core/src/fields/index.ts#L362)

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
