# Interface: RelationshipFieldOptions

Defined in: [packages/core/src/fields/index.ts:113](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/fields/index.ts#L113)

Configuration options for relationship fields (foreign keys, associations)

 RelationshipFieldOptions

## Extends

- [`FieldOptions`](FieldOptions.md)

## Properties

### customMessage?

> `optional` **customMessage**: `string`

Defined in: [packages/core/src/fields/index.ts:74](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/fields/index.ts#L74)

Custom error message to display when validation fails
Works with both built-in validators and custom validate functions

#### Inherited from

[`FieldOptions`](FieldOptions.md).[`customMessage`](FieldOptions.md#custommessage)

***

### default?

> `optional` **default**: `any`

Defined in: [packages/core/src/fields/index.ts:47](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/fields/index.ts#L47)

Default value for this field when creating new objects

#### Inherited from

[`FieldOptions`](FieldOptions.md).[`default`](FieldOptions.md#default)

***

### description?

> `optional` **description**: `string`

Defined in: [packages/core/src/fields/index.ts:53](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/fields/index.ts#L53)

Human-readable description of the field's purpose

#### Inherited from

[`FieldOptions`](FieldOptions.md).[`description`](FieldOptions.md#description)

***

### index?

> `optional` **index**: `boolean`

Defined in: [packages/core/src/fields/index.ts:51](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/fields/index.ts#L51)

Whether to create a database index on this field for faster queries

#### Inherited from

[`FieldOptions`](FieldOptions.md).[`index`](FieldOptions.md#index)

***

### nullable?

> `optional` **nullable**: `boolean`

Defined in: [packages/core/src/fields/index.ts:45](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/fields/index.ts#L45)

Whether this field can be null (allows NULL values, opposite of required)

#### Inherited from

[`FieldOptions`](FieldOptions.md).[`nullable`](FieldOptions.md#nullable)

***

### onDelete?

> `optional` **onDelete**: `"cascade"` \| `"restrict"` \| `"set_null"`

Defined in: [packages/core/src/fields/index.ts:115](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/fields/index.ts#L115)

What to do when the referenced object is deleted

***

### primaryKey?

> `optional` **primaryKey**: `boolean`

Defined in: [packages/core/src/fields/index.ts:41](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/fields/index.ts#L41)

Whether this field is the primary key (default: false, 'id' field is auto-generated)

#### Inherited from

[`FieldOptions`](FieldOptions.md).[`primaryKey`](FieldOptions.md#primarykey)

***

### related?

> `optional` **related**: `string`

Defined in: [packages/core/src/fields/index.ts:117](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/fields/index.ts#L117)

Name of the related class (automatically set by relationship functions)

***

### required?

> `optional` **required**: `boolean`

Defined in: [packages/core/src/fields/index.ts:43](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/fields/index.ts#L43)

Whether this field is required (NOT NULL constraint)

#### Inherited from

[`FieldOptions`](FieldOptions.md).[`required`](FieldOptions.md#required)

***

### transient?

> `optional` **transient**: `boolean`

Defined in: [packages/core/src/fields/index.ts:55](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/fields/index.ts#L55)

Whether this field is transient (not persisted to database) - useful for computed properties, functions, etc.

#### Inherited from

[`FieldOptions`](FieldOptions.md).[`transient`](FieldOptions.md#transient)

***

### unique?

> `optional` **unique**: `boolean`

Defined in: [packages/core/src/fields/index.ts:49](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/fields/index.ts#L49)

Whether this field must have unique values (UNIQUE constraint)

#### Inherited from

[`FieldOptions`](FieldOptions.md).[`unique`](FieldOptions.md#unique)

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

#### Inherited from

[`FieldOptions`](FieldOptions.md).[`validate`](FieldOptions.md#validate)
