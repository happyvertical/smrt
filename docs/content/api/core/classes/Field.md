# Class: Field

Defined in: [packages/core/src/fields/index.ts:152](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/fields/index.ts#L152)

Base field class that all field types extend

Represents a database field with type information, validation rules,
and SQL generation capabilities. All field functions return instances
of this class with specific type and options configurations.

 Field

## Constructors

### Constructor

> **new Field**(`type`, `options`): `Field`

Defined in: [packages/core/src/fields/index.ts:157](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/fields/index.ts#L157)

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

Defined in: [packages/core/src/fields/index.ts:154](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/fields/index.ts#L154)

***

### type

> `readonly` **type**: `string`

Defined in: [packages/core/src/fields/index.ts:153](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/fields/index.ts#L153)

***

### value

> **value**: `any`

Defined in: [packages/core/src/fields/index.ts:155](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/fields/index.ts#L155)

## Accessors

### transient

#### Get Signature

> **get** **transient**(): `boolean` \| `undefined`

Defined in: [packages/core/src/fields/index.ts:167](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/fields/index.ts#L167)

Check if this field is transient (not persisted to database)
Convenience getter that checks options.transient

##### Returns

`boolean` \| `undefined`

## Methods

### \[toPrimitive\]()

> **\[toPrimitive\]**(`hint`): `any`

Defined in: [packages/core/src/fields/index.ts:184](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/fields/index.ts#L184)

Primitive type coercion - makes Field instances transparently coerce to their values
Called automatically by JavaScript in various contexts (string concat, arithmetic, comparisons)

#### Parameters

##### hint

`string`

Type hint from JavaScript engine ('string', 'number', or 'default')

#### Returns

`any`

The field's value coerced to the appropriate type

#### Example

```typescript
const age = integer({ default: 25 });
console.log(age + 5);        // 30 - hint='number'
console.log('Age: ' + age);  // 'Age: 25' - hint='string'
if (age == 25) { }           // true - hint='default'
```

***

### getSqlConstraints()

> **getSqlConstraints**(): `string`[]

Defined in: [packages/core/src/fields/index.ts:280](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/fields/index.ts#L280)

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

Defined in: [packages/core/src/fields/index.ts:246](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/fields/index.ts#L246)

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

Defined in: [packages/core/src/fields/index.ts:232](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/fields/index.ts#L232)

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

Defined in: [packages/core/src/fields/index.ts:205](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/fields/index.ts#L205)

String coercion - allows Field instances to be used naturally in string contexts

#### Returns

`string`

String representation of the field's value

#### Example

```typescript
const name = text({ default: 'John' });
console.log(name.toLowerCase()); // 'john' - toString() called automatically
console.log(String(name));       // 'John'
```

***

### valueOf()

> **valueOf**(): `any`

Defined in: [packages/core/src/fields/index.ts:219](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/fields/index.ts#L219)

Value coercion - returns the actual value for comparisons and operations

#### Returns

`any`

The field's value

#### Example

```typescript
const age = integer({ default: 25 });
console.log(age + 5); // 30 - valueOf() called automatically
console.log(+age);    // 25 - unary plus operator
```
