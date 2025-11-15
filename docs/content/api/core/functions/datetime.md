# Function: datetime()

> **datetime**(`options`): [`Field`](../classes/Field.md)

Defined in: [packages/core/src/fields/index.ts:423](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/fields/index.ts#L423)

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
