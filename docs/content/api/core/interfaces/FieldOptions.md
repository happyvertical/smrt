# Interface: FieldOptions

Defined in: [packages/core/src/fields/index.ts:39](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/fields/index.ts#L39)

Base configuration options available for all field types

 FieldOptions

## Extended by

- [`NumericFieldOptions`](NumericFieldOptions.md)
- [`TextFieldOptions`](TextFieldOptions.md)
- [`RelationshipFieldOptions`](RelationshipFieldOptions.md)

## Properties

### customMessage?

> `optional` **customMessage**: `string`

Defined in: [packages/core/src/fields/index.ts:74](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/fields/index.ts#L74)

Custom error message to display when validation fails
Works with both built-in validators and custom validate functions

***

### default?

> `optional` **default**: `any`

Defined in: [packages/core/src/fields/index.ts:47](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/fields/index.ts#L47)

Default value for this field when creating new objects

***

### description?

> `optional` **description**: `string`

Defined in: [packages/core/src/fields/index.ts:53](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/fields/index.ts#L53)

Human-readable description of the field's purpose

***

### index?

> `optional` **index**: `boolean`

Defined in: [packages/core/src/fields/index.ts:51](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/fields/index.ts#L51)

Whether to create a database index on this field for faster queries

***

### nullable?

> `optional` **nullable**: `boolean`

Defined in: [packages/core/src/fields/index.ts:45](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/fields/index.ts#L45)

Whether this field can be null (allows NULL values, opposite of required)

***

### primaryKey?

> `optional` **primaryKey**: `boolean`

Defined in: [packages/core/src/fields/index.ts:41](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/fields/index.ts#L41)

Whether this field is the primary key (default: false, 'id' field is auto-generated)

***

### required?

> `optional` **required**: `boolean`

Defined in: [packages/core/src/fields/index.ts:43](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/fields/index.ts#L43)

Whether this field is required (NOT NULL constraint)

***

### transient?

> `optional` **transient**: `boolean`

Defined in: [packages/core/src/fields/index.ts:55](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/fields/index.ts#L55)

Whether this field is transient (not persisted to database) - useful for computed properties, functions, etc.

***

### unique?

> `optional` **unique**: `boolean`

Defined in: [packages/core/src/fields/index.ts:49](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/fields/index.ts#L49)

Whether this field must have unique values (UNIQUE constraint)

***

### validate()?

> `optional` **validate**: (`value`) => `boolean` \| `Promise`\<`boolean`\>

Defined in: [packages/core/src/fields/index.ts:69](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/fields/index.ts#L69)

Custom validation function (synchronous or asynchronous)
Should return true if valid, false if invalid

#### Parameters

##### value

`any`

The field value to validate

#### Returns

`boolean` \| `Promise`\<`boolean`\>

Boolean indicating validity

#### Example

```typescript
email = text({
  validate: (v) => /^[^@]+@[^@]+\.[^@]+$/.test(v),
  customMessage: 'Invalid email format'
});
```
