# Interface: TextFieldOptions

Defined in: [smrt/packages/core/src/fields/index.ts:92](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/fields/index.ts#L92)

Configuration options for text fields

 TextFieldOptions

## Extends

- [`FieldOptions`](FieldOptions.md)

## Properties

### customMessage?

> `optional` **customMessage**: `string`

Defined in: [smrt/packages/core/src/fields/index.ts:70](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/fields/index.ts#L70)

Custom error message to display when validation fails
Works with both built-in validators and custom validate functions

#### Inherited from

[`FieldOptions`](FieldOptions.md).[`customMessage`](FieldOptions.md#custommessage)

***

### default?

> `optional` **default**: `any`

Defined in: [smrt/packages/core/src/fields/index.ts:45](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/fields/index.ts#L45)

Default value for this field when creating new objects

#### Inherited from

[`FieldOptions`](FieldOptions.md).[`default`](FieldOptions.md#default)

***

### description?

> `optional` **description**: `string`

Defined in: [smrt/packages/core/src/fields/index.ts:51](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/fields/index.ts#L51)

Human-readable description of the field's purpose

#### Inherited from

[`FieldOptions`](FieldOptions.md).[`description`](FieldOptions.md#description)

***

### encrypted?

> `optional` **encrypted**: `boolean`

Defined in: [smrt/packages/core/src/fields/index.ts:100](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/fields/index.ts#L100)

Whether to encrypt this field's value in storage

***

### index?

> `optional` **index**: `boolean`

Defined in: [smrt/packages/core/src/fields/index.ts:49](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/fields/index.ts#L49)

Whether to create a database index on this field for faster queries

#### Inherited from

[`FieldOptions`](FieldOptions.md).[`index`](FieldOptions.md#index)

***

### maxLength?

> `optional` **maxLength**: `number`

Defined in: [smrt/packages/core/src/fields/index.ts:94](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/fields/index.ts#L94)

Maximum length in characters

***

### minLength?

> `optional` **minLength**: `number`

Defined in: [smrt/packages/core/src/fields/index.ts:96](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/fields/index.ts#L96)

Minimum length in characters

***

### pattern?

> `optional` **pattern**: `string`

Defined in: [smrt/packages/core/src/fields/index.ts:98](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/fields/index.ts#L98)

Regular expression pattern for validation

***

### primaryKey?

> `optional` **primaryKey**: `boolean`

Defined in: [smrt/packages/core/src/fields/index.ts:41](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/fields/index.ts#L41)

Whether this field is the primary key (default: false, 'id' field is auto-generated)

#### Inherited from

[`FieldOptions`](FieldOptions.md).[`primaryKey`](FieldOptions.md#primarykey)

***

### required?

> `optional` **required**: `boolean`

Defined in: [smrt/packages/core/src/fields/index.ts:43](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/fields/index.ts#L43)

Whether this field is required (NOT NULL constraint)

#### Inherited from

[`FieldOptions`](FieldOptions.md).[`required`](FieldOptions.md#required)

***

### unique?

> `optional` **unique**: `boolean`

Defined in: [smrt/packages/core/src/fields/index.ts:47](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/fields/index.ts#L47)

Whether this field must have unique values (UNIQUE constraint)

#### Inherited from

[`FieldOptions`](FieldOptions.md).[`unique`](FieldOptions.md#unique)

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

#### Inherited from

[`FieldOptions`](FieldOptions.md).[`validate`](FieldOptions.md#validate)
