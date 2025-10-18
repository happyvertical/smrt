# Interface: FieldOptions

Defined in: [smrt/packages/core/src/fields/index.ts:39](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/fields/index.ts#L39)

Base configuration options available for all field types

 FieldOptions

## Extended by

- [`NumericFieldOptions`](NumericFieldOptions.md)
- [`TextFieldOptions`](TextFieldOptions.md)
- [`RelationshipFieldOptions`](RelationshipFieldOptions.md)

## Properties

### customMessage?

> `optional` **customMessage**: `string`

Defined in: [smrt/packages/core/src/fields/index.ts:70](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/fields/index.ts#L70)

Custom error message to display when validation fails
Works with both built-in validators and custom validate functions

***

### default?

> `optional` **default**: `any`

Defined in: [smrt/packages/core/src/fields/index.ts:45](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/fields/index.ts#L45)

Default value for this field when creating new objects

***

### description?

> `optional` **description**: `string`

Defined in: [smrt/packages/core/src/fields/index.ts:51](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/fields/index.ts#L51)

Human-readable description of the field's purpose

***

### index?

> `optional` **index**: `boolean`

Defined in: [smrt/packages/core/src/fields/index.ts:49](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/fields/index.ts#L49)

Whether to create a database index on this field for faster queries

***

### primaryKey?

> `optional` **primaryKey**: `boolean`

Defined in: [smrt/packages/core/src/fields/index.ts:41](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/fields/index.ts#L41)

Whether this field is the primary key (default: false, 'id' field is auto-generated)

***

### required?

> `optional` **required**: `boolean`

Defined in: [smrt/packages/core/src/fields/index.ts:43](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/fields/index.ts#L43)

Whether this field is required (NOT NULL constraint)

***

### unique?

> `optional` **unique**: `boolean`

Defined in: [smrt/packages/core/src/fields/index.ts:47](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/fields/index.ts#L47)

Whether this field must have unique values (UNIQUE constraint)

***

### validate()?

> `optional` **validate**: (`value`) => `boolean` \| `Promise`\<`boolean`\>

Defined in: [smrt/packages/core/src/fields/index.ts:65](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/fields/index.ts#L65)

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
