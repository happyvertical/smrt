# Function: meta()

> **meta**\<`T`\>(`options`): [`Field`](../classes/Field.md)

Defined in: [packages/core/src/fields/index.ts:668](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/fields/index.ts#L668)

Creates a meta field for STI (Single Table Inheritance)

Meta fields are stored in the `_meta_data` JSONB column instead of as
regular table columns. This is useful for fields that are specific to
child classes in an STI hierarchy.

**Usage patterns**:
- TypeScript type annotation: `arenaName: Meta<string> = ''`
- Field helper with options: `arenaName = meta<string>({ required: true })`
- Combined (type + helper): Both patterns together

## Type Parameters

### T

`T` = `any`

The TypeScript type of the meta field value

## Parameters

### options

[`FieldOptions`](../interfaces/FieldOptions.md) = `{}`

Configuration options for the meta field

## Returns

[`Field`](../classes/Field.md)

Field instance configured for meta storage

## Examples

```typescript
@smrt({ tableStrategy: 'sti' })
class HockeyGame extends Event {
  // TypeScript-first: AST scanner detects Meta<T> type
  arenaName: Meta<string> = '';
  capacity: Meta<number> = 0;
}
```

```typescript
@smrt({ tableStrategy: 'sti' })
class HockeyGame extends Event {
  // Field helper: Allows constraints and validation
  arenaName = meta<string>({ required: true, maxLength: 100 });
  capacity = meta<number>({ min: 0, max: 100000 });
}
```

```typescript
@smrt({ tableStrategy: 'sti' })
class HockeyGame extends Event {
  // Both: Type safety + constraints
  arenaName: Meta<string> = meta({ required: true, maxLength: 100 });
  capacity: Meta<number> = meta({ min: 0, max: 100000 });
}
```
