# Class: Field

Defined in: smrt/packages/core/src/fields/index.ts:125

Base field class that all field types extend

Represents a database field with type information, validation rules,
and SQL generation capabilities. All field functions return instances
of this class with specific type and options configurations.

 Field

## Constructors

### Constructor

> **new Field**(`type`, `options`): `Field`

Defined in: smrt/packages/core/src/fields/index.ts:130

#### Parameters

##### type

`string`

##### options

[`FieldOptions`](../interfaces/FieldOptions.md) = `{}`

#### Returns

`Field`

## Properties

### options

> `readonly` **options**: [`FieldOptions`](../interfaces/FieldOptions.md)

Defined in: smrt/packages/core/src/fields/index.ts:127

***

### type

> `readonly` **type**: `string`

Defined in: smrt/packages/core/src/fields/index.ts:126

***

### value

> **value**: `any`

Defined in: smrt/packages/core/src/fields/index.ts:128

## Methods

### getSqlConstraints()

> **getSqlConstraints**(): `string`[]

Defined in: smrt/packages/core/src/fields/index.ts:219

Get field constraints for SQL DDL statements

#### Returns

`string`[]

Array of SQL constraint strings (e.g., ['NOT NULL', 'UNIQUE', 'PRIMARY KEY'])

#### Example

```typescript
const emailField = text({ required: true, unique: true });
console.log(emailField.getSqlConstraints()); // ['NOT NULL', 'UNIQUE']

const slugField = text({ primaryKey: true });
console.log(slugField.getSqlConstraints()); // ['PRIMARY KEY']
```

***

### getSqlType()

> **getSqlType**(): `string`

Defined in: smrt/packages/core/src/fields/index.ts:185

Get the SQL type for this field based on the field type

#### Returns

`string`

SQL type string (e.g., 'TEXT', 'INTEGER', 'REAL')

#### Example

```typescript
const nameField = text();
console.log(nameField.getSqlType()); // 'TEXT'
```

***

### toJSON()

> **toJSON**(): `any`

Defined in: smrt/packages/core/src/fields/index.ts:171

JSON serialization - returns the value for JSON.stringify()

#### Returns

`any`

The field's value for JSON serialization

#### Example

```typescript
const data = { name: text({ default: 'John' }) };
JSON.stringify(data); // {"name":"John"} - toJSON() called automatically
```

***

### toString()

> **toString**(): `string`

Defined in: smrt/packages/core/src/fields/index.ts:145

String coercion - allows Field instances to be used naturally in string contexts

#### Returns

`string`

String representation of the field's value

#### Example

```typescript
const name = text({ default: 'John' });
console.log(name.toLowerCase()); // 'john' - toString() called automatically
```

***

### valueOf()

> **valueOf**(): `any`

Defined in: smrt/packages/core/src/fields/index.ts:158

Value coercion - returns the actual value for comparisons and operations

#### Returns

`any`

The field's value

#### Example

```typescript
const age = integer({ default: 25 });
console.log(age + 5); // 30 - valueOf() called automatically
```
