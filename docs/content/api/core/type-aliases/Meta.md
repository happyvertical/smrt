# Type Alias: Meta\<T\>

> **Meta**\<`T`\> = `T`

Defined in: [packages/core/src/fields/index.ts:141](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/fields/index.ts#L141)

Type wrapper for meta fields in STI (Single Table Inheritance)

Marks a field to be stored in the `_meta_data` JSONB column
instead of as a regular table column. Only used with `tableStrategy: 'sti'`.

## Type Parameters

### T

`T`

The TypeScript type of the meta field value

## Example

```typescript
@smrt({ tableStrategy: 'sti' })
class HockeyGame extends Event {
  // Stored in _meta_data JSONB column
  arenaName: Meta<string> = '';
  capacity: Meta<number> = 0;

  // Regular fields (stored in columns)
  title: string = '';
  homeTeamId = foreignKey(Team);
}
```
