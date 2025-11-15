# Class: SmrtCollection\<ModelType\>

Defined in: [packages/core/src/collection.ts:28](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/collection.ts#L28)

Collection interface for managing sets of SmrtObjects

SmrtCollection provides methods for querying, creating, and managing
collections of persistent objects. It handles database setup, schema
generation, and provides a fluent interface for querying objects.

## Extends

- [`SmrtClass`](SmrtClass.md)

## Type Parameters

### ModelType

`ModelType` *extends* [`SmrtObject`](SmrtObject.md)

## Constructors

### Constructor

> `protected` **new SmrtCollection**\<`ModelType`\>(`options`): `SmrtCollection`\<`ModelType`\>

Defined in: [packages/core/src/collection.ts:280](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/collection.ts#L280)

Creates a new SmrtCollection instance

#### Parameters

##### options

[`SmrtCollectionOptions`](../interfaces/SmrtCollectionOptions.md) = `{}`

Configuration options

#### Returns

`SmrtCollection`\<`ModelType`\>

#### Deprecated

Use the static create() factory method instead

#### Overrides

[`SmrtClass`](SmrtClass.md).[`constructor`](SmrtClass.md#constructor)

## Properties

### \_ai

> `protected` **\_ai**: `AIClient`

Defined in: [packages/core/src/class.ts:112](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L112)

AI client instance for interacting with AI models

#### Inherited from

[`SmrtClass`](SmrtClass.md).[`_ai`](SmrtClass.md#_ai)

***

### \_className

> `protected` **\_className**: `string`

Defined in: [packages/core/src/class.ts:127](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L127)

Class name used for identification

#### Inherited from

[`SmrtClass`](SmrtClass.md).[`_className`](SmrtClass.md#_classname)

***

### \_db

> `protected` **\_db**: `DatabaseInterface`

Defined in: [packages/core/src/class.ts:122](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L122)

Database interface for data persistence

#### Inherited from

[`SmrtClass`](SmrtClass.md).[`_db`](SmrtClass.md#_db)

***

### \_db\_setup\_promise

> `protected` **\_db\_setup\_promise**: `Promise`\<`void`\> \| `null` = `null`

Defined in: [packages/core/src/collection.ts:32](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/collection.ts#L32)

Promise tracking the database setup operation

***

### \_fs

> `protected` **\_fs**: `FilesystemAdapter`

Defined in: [packages/core/src/class.ts:117](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L117)

Filesystem adapter for file operations

#### Inherited from

[`SmrtClass`](SmrtClass.md).[`_fs`](SmrtClass.md#_fs)

***

### \_signalBus?

> `protected` `optional` **\_signalBus**: [`SignalBus`](SignalBus.md)

Defined in: [packages/core/src/class.ts:132](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L132)

Signal bus for method execution tracking

#### Inherited from

[`SmrtClass`](SmrtClass.md).[`_signalBus`](SmrtClass.md#_signalbus)

***

### \_tableName

> **\_tableName**: `string`

Defined in: [packages/core/src/collection.ts:272](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/collection.ts#L272)

Database table name for this collection

***

### options

> **options**: [`SmrtClassOptions`](../interfaces/SmrtClassOptions.md)

Defined in: [packages/core/src/class.ts:142](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L142)

Configuration options provided to the class

#### Inherited from

[`SmrtClass`](SmrtClass.md).[`options`](SmrtClass.md#options)

***

### \_itemClass

> `readonly` `static` **\_itemClass**: `any`

Defined in: [packages/core/src/collection.ts:230](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/collection.ts#L230)

Static reference to the item class constructor

## Accessors

### \_itemClass

#### Get Signature

> **get** `protected` **\_itemClass**(): (`options`) => `ModelType` & `object`

Defined in: [packages/core/src/collection.ts:197](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/collection.ts#L197)

Gets the class constructor for items in this collection

##### Returns

(`options`) => `ModelType` & `object`

***

### ai

#### Get Signature

> **get** **ai**(): `AIClient`

Defined in: [packages/core/src/class.ts:507](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L507)

Gets the AI client instance

##### Returns

`AIClient`

#### Inherited from

[`SmrtClass`](SmrtClass.md).[`ai`](SmrtClass.md#ai)

***

### db

#### Get Signature

> **get** **db**(): `DatabaseInterface`

Defined in: [packages/core/src/class.ts:493](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L493)

Gets the database interface instance

##### Returns

`DatabaseInterface`

#### Inherited from

[`SmrtClass`](SmrtClass.md).[`db`](SmrtClass.md#db)

***

### fs

#### Get Signature

> **get** **fs**(): `FilesystemAdapter`

Defined in: [packages/core/src/class.ts:486](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L486)

Gets the filesystem adapter instance

##### Returns

`FilesystemAdapter`

#### Inherited from

[`SmrtClass`](SmrtClass.md).[`fs`](SmrtClass.md#fs)

***

### signalBus

#### Get Signature

> **get** **signalBus**(): [`SignalBus`](SignalBus.md) \| `undefined`

Defined in: [packages/core/src/class.ts:516](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L516)

Gets the signal bus instance

##### Returns

[`SignalBus`](SignalBus.md) \| `undefined`

Signal bus if signals are enabled, undefined otherwise

#### Inherited from

[`SmrtClass`](SmrtClass.md).[`signalBus`](SmrtClass.md#signalbus)

***

### systemDb

#### Get Signature

> **get** `protected` **systemDb**(): `DatabaseInterface`

Defined in: [packages/core/src/class.ts:365](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L365)

Access system tables through standard database interface
System tables use _smrt_ prefix to avoid conflicts with user tables

##### Returns

`DatabaseInterface`

#### Inherited from

[`SmrtClass`](SmrtClass.md).[`systemDb`](SmrtClass.md#systemdb)

***

### tableName

#### Get Signature

> **get** **tableName**(): `string`

Defined in: [packages/core/src/collection.ts:1056](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/collection.ts#L1056)

Gets the database table name for this collection

##### Returns

`string`

## Methods

### count()

> **count**(`options`): `Promise`\<`number`\>

Defined in: [packages/core/src/collection.ts:1114](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/collection.ts#L1114)

Counts records in the collection matching the given filters

Accepts the same where conditions as list() but ignores limit/offset/orderBy.

#### Parameters

##### options

Query options object

###### where?

`Record`\<`string`, `any`\>

Record of conditions to filter results

#### Returns

`Promise`\<`number`\>

Promise resolving to the total count of matching records

***

### create()

> **create**(`options`): `Promise`\<`ModelType`\>

Defined in: [packages/core/src/collection.ts:857](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/collection.ts#L857)

Creates a new instance of the collection's item class

#### Parameters

##### options

`any`

Options for creating the item

#### Returns

`Promise`\<`ModelType`\>

New item instance

***

### destroy()

> **destroy**(): `void`

Defined in: [packages/core/src/class.ts:535](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L535)

Cleanup method to prevent memory leaks

Unregisters all adapters from the signal bus that were registered
by this instance. Call this when the SmrtClass instance is no longer
needed to prevent memory leaks.

#### Returns

`void`

#### Example

```typescript
const product = new Product({ name: 'Widget' });
await product.initialize();
// ... use product ...
product.destroy(); // Clean up when done
```

#### Inherited from

[`SmrtClass`](SmrtClass.md).[`destroy`](SmrtClass.md#destroy)

***

### findAll()

> **findAll**(`options`): `Promise`\<`ModelType`[]\>

Defined in: [packages/core/src/collection.ts:433](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/collection.ts#L433)

Find all records matching criteria (convenience method - delegates to list())

#### Parameters

##### options

Query options (where, orderBy, limit, etc.)

###### include?

`string`[]

###### limit?

`number`

###### offset?

`number`

###### orderBy?

`string` \| `string`[]

###### where?

`Record`\<`string`, `any`\>

#### Returns

`Promise`\<`ModelType`[]\>

Promise resolving to array of objects

#### Example

```typescript
const councils = await Councils.create({ persistence: { type: 'sql', url: 'db.sqlite' } });
const active = await councils.findAll({ where: { status: 'active' } });
```

***

### findById()

> **findById**(`id`): `Promise`\<`ModelType` \| `null`\>

Defined in: [packages/core/src/collection.ts:413](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/collection.ts#L413)

Find a record by ID (convenience method - delegates to get())

#### Parameters

##### id

Record ID to find (string or Field instance)

`string` | [`Field`](Field.md)

#### Returns

`Promise`\<`ModelType` \| `null`\>

Promise resolving to the object or null if not found

#### Example

```typescript
const councils = await Councils.create({ persistence: { type: 'sql', url: 'db.sqlite' } });
const council = await councils.findById('uuid-123');

// Also works with Field instances (e.g., from foreignKey fields)
const meeting = new Meeting({ councilId: 'uuid-123' });
const council = await councils.findById(meeting.councilId);
```

***

### findOne()

> **findOne**(`options`): `Promise`\<`ModelType` \| `null`\>

Defined in: [packages/core/src/collection.ts:391](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/collection.ts#L391)

Find a single record by criteria (convenience method - delegates to get())

#### Parameters

##### options

Query options with where clause

###### where

`Record`\<`string`, `any`\>

#### Returns

`Promise`\<`ModelType` \| `null`\>

Promise resolving to the object or null if not found

#### Example

```typescript
const councils = await Councils.create({ persistence: { type: 'sql', url: 'db.sqlite' } });
const council = await councils.findOne({ where: { name: 'Example Council' } });
```

***

### forget()

> **forget**(`options`): `Promise`\<`void`\>

Defined in: [packages/core/src/collection.ts:1358](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/collection.ts#L1358)

Forget collection-level context

Deletes collection context by scope and key.

#### Parameters

##### options

Context identification

###### key

`string`

###### scope

`string`

#### Returns

`Promise`\<`void`\>

Promise that resolves when context is deleted

#### Example

```typescript
// Remove a default strategy
await documentCollection.forget({
  scope: 'parser/default',
  key: 'selector'
});
```

***

### forgetScope()

> **forgetScope**(`options`): `Promise`\<`number`\>

Defined in: [packages/core/src/collection.ts:1389](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/collection.ts#L1389)

Forget all collection-level context in a scope

Deletes all collection contexts matching the scope pattern.

#### Parameters

##### options

Scope options

###### includeDescendants?

`boolean`

###### scope

`string`

#### Returns

`Promise`\<`number`\>

Promise resolving to number of contexts deleted

#### Example

```typescript
// Clear all default strategies
const count = await documentCollection.forgetScope({
  scope: 'parser/default',
  includeDescendants: true
});
```

***

### generateSchema()

> **generateSchema**(): `Promise`\<`string`\>

Defined in: [packages/core/src/collection.ts:1048](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/collection.ts#L1048)

Generates database schema for the collection's item class

Leverages ObjectRegistry's cached schema for instant retrieval.

#### Returns

`Promise`\<`string`\>

Schema object for database setup

***

### generateTableName()

> **generateTableName**(): `string`

Defined in: [packages/core/src/collection.ts:1090](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/collection.ts#L1090)

Generates a table name from the collection class name

#### Returns

`string`

Generated table name

***

### get()

> **get**(`filter`): `Promise`\<`ModelType` \| `null`\>

Defined in: [packages/core/src/collection.ts:451](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/collection.ts#L451)

Retrieves a single object from the collection by ID, slug, or custom filter

#### Parameters

##### filter

String ID/slug, Field instance, or object with filter conditions

`string` | `Record`\<`string`, `any`\> | [`Field`](Field.md)

#### Returns

`Promise`\<`ModelType` \| `null`\>

Promise resolving to the object or null if not found

***

### getDiff()

> **getDiff**(`existing`, `data`): `Promise`\<`Record`\<`string`, `any`\>\>

Defined in: [packages/core/src/collection.ts:965](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/collection.ts#L965)

Gets differences between an existing object and new data

#### Parameters

##### existing

`Record`\<`string`, `any`\>

Existing object

##### data

`Record`\<`string`, `any`\>

New data

#### Returns

`Promise`\<`Record`\<`string`, `any`\>\>

Object containing only the changed fields

***

### getFields()

> **getFields**(): `Promise`\<`Record`\<`string`, `any`\>\>

Defined in: [packages/core/src/collection.ts:1037](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/collection.ts#L1037)

Gets field definitions for the collection's item class

#### Returns

`Promise`\<`Record`\<`string`, `any`\>\>

Object containing field definitions

***

### getOrUpsert()

> **getOrUpsert**(`data`, `defaults`): `Promise`\<`ModelType`\>

Defined in: [packages/core/src/collection.ts:932](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/collection.ts#L932)

Gets an existing item or creates a new one if it doesn't exist

#### Parameters

##### data

`any`

Object data to find or create

##### defaults

`any` = `{}`

Default values to use if creating a new object

#### Returns

`Promise`\<`ModelType`\>

Promise resolving to the existing or new object

***

### initialize()

> **initialize**(): `Promise`\<`SmrtCollection`\<`ModelType`\>\>

Defined in: [packages/core/src/collection.ts:369](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/collection.ts#L369)

Initializes the collection, setting up database tables

#### Returns

`Promise`\<`SmrtCollection`\<`ModelType`\>\>

Promise that resolves to this instance for chaining

#### Overrides

[`SmrtClass`](SmrtClass.md).[`initialize`](SmrtClass.md#initialize)

***

### list()

> **list**(`options`): `Promise`\<`ModelType`[]\>

Defined in: [packages/core/src/collection.ts:540](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/collection.ts#L540)

Lists records from the collection with flexible filtering options

#### Parameters

##### options

Query options object

###### include?

`string`[]

Relationships to eagerly load (avoids N+1 query problem)

**Example**

```typescript
// Load orders with their customers pre-loaded
const orders = await orderCollection.list({
  include: ['customerId']
});
// Access customer without additional query
orders[0].getRelated('customerId');
```

###### limit?

`number`

Maximum number of records to return

###### offset?

`number`

Number of records to skip

###### orderBy?

`string` \| `string`[]

Field(s) to order results by, with optional direction

###### where?

`Record`\<`string`, `any`\>

Record of conditions to filter results. Each key can include an operator
                     separated by a space (e.g., 'price >', 'name like'). Default operator is '='.

#### Returns

`Promise`\<`ModelType`[]\>

Promise resolving to an array of model instances

#### Example

```typescript
// Find active products priced between $100-$200
await collection.list({
  where: {
    'price >': 100,
    'price <=': 200,
    'status': 'active',              // equals operator is default
    'category in': ['A', 'B', 'C'],  // IN operator for arrays
    'name like': '%shirt%',          // LIKE for pattern matching
    'deleted_at !=': null            // exclude deleted items
  },
  limit: 10,
  offset: 0
});

// Find users matching pattern but not in specific roles
await users.list({
  where: {
    'email like': '%@company.com',
    'active': true,
    'role in': ['guest', 'blocked'],
    'last_login <': lastMonth
  }
});
```

***

### recall()

> **recall**(`options`): `Promise`\<`any`\>

Defined in: [packages/core/src/collection.ts:1219](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/collection.ts#L1219)

Recall collection-level context

Retrieves context that applies to all instances of this collection.

#### Parameters

##### options

Recall options

###### includeAncestors?

`boolean`

###### key

`string`

###### minConfidence?

`number`

###### scope

`string`

#### Returns

`Promise`\<`any`\>

Promise resolving to the context value or null if not found

#### Example

```typescript
// Recall default parsing strategy
const strategy = await documentCollection.recall({
  scope: 'parser/default',
  key: 'selector',
  minConfidence: 0.5
});
```

***

### recallAll()

> **recallAll**(`options`): `Promise`\<`Map`\<`string`, `any`\>\>

Defined in: [packages/core/src/collection.ts:1296](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/collection.ts#L1296)

Recall all collection-level context in a scope

Returns a Map of key -> value for all collection contexts matching the criteria.

#### Parameters

##### options

Recall options

###### includeDescendants?

`boolean`

###### minConfidence?

`number`

###### scope?

`string`

#### Returns

`Promise`\<`Map`\<`string`, `any`\>\>

Promise resolving to Map of key -> value pairs

#### Example

```typescript
// Get all default strategies
const strategies = await documentCollection.recallAll({
  scope: 'parser/default',
  minConfidence: 0.5
});
```

***

### remember()

> **remember**(`options`): `Promise`\<`void`\>

Defined in: [packages/core/src/collection.ts:1158](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/collection.ts#L1158)

Remember collection-level context

Stores context applicable to all instances of this collection type.
Use for patterns that apply to the entire collection (e.g., default parsing strategies).

#### Parameters

##### options

Context options

###### confidence?

`number`

###### expiresAt?

`Date`

###### id?

`string`

###### key

`string`

###### metadata?

`any`

###### scope

`string`

###### value

`any`

###### version?

`number`

#### Returns

`Promise`\<`void`\>

Promise that resolves when context is stored

#### Example

```typescript
// Remember a default parsing strategy for all documents
await documentCollection.remember({
  scope: 'parser/default',
  key: 'selector',
  value: { pattern: '.content article' },
  confidence: 0.8
});

// Update an existing context entry by specifying id
await documentCollection.remember({
  id: 'existing-context-id',
  scope: 'parser/default',
  key: 'selector',
  value: { pattern: '.content main article' },
  confidence: 0.85
});
```

***

### requiresDatabase()

> `protected` **requiresDatabase**(): `boolean`

Defined in: [packages/core/src/class.ts:178](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L178)

Determines whether this class requires a database to function

Override this method in subclasses that require database access
to enable early validation during initialization.

#### Returns

`boolean`

True if database is required, false otherwise

#### Example

```typescript
class MyDataModel extends SmrtClass {
  protected requiresDatabase(): boolean {
    return true; // This class needs database access
  }
}
```

#### Inherited from

[`SmrtClass`](SmrtClass.md).[`requiresDatabase`](SmrtClass.md#requiresdatabase)

***

### setupDb()

> **setupDb**(): `Promise`\<`void`\>

Defined in: [packages/core/src/collection.ts:986](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/collection.ts#L986)

Sets up the database schema for this collection

#### Returns

`Promise`\<`void`\>

Promise that resolves when setup is complete

***

### create()

> `static` **create**\<`T`\>(`this`, `options`): `Promise`\<`T`\>

Defined in: [packages/core/src/collection.ts:320](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/collection.ts#L320)

Static factory method for creating fully initialized collection instances

This is the recommended way to create collections. It accepts broad option types
(SmrtClassOptions) and handles option extraction internally, then returns a
fully initialized, ready-to-use collection instance.

TypeScript Note: Uses instance type constraint (T extends SmrtCollection<any>)
with constructor type for 'this' parameter to properly preserve subclass types
through the static factory method. This ensures custom collection methods are
properly typed and subclass constructors are compatible.

#### Type Parameters

##### T

`T` *extends* `SmrtCollection`\<`any`\>

#### Parameters

##### this

(`options?`) => `T`

##### options

[`SmrtClassOptions`](../interfaces/SmrtClassOptions.md) = `{}`

Configuration options (accepts both SmrtClassOptions and SmrtCollectionOptions)

#### Returns

`Promise`\<`T`\>

Promise resolving to a fully initialized collection instance

#### Example

```typescript
// Create collection from object options
const collection = await ProductCollection.create(smrtObject.options);

// Create collection with specific config
const collection = await ProductCollection.create({
  persistence: { type: 'sql', url: 'products.db' },
  ai: { provider: 'openai', apiKey: process.env.OPENAI_API_KEY }
});
```

***

### validate()

> `static` **validate**(): `void`

Defined in: [packages/core/src/collection.ts:236](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/collection.ts#L236)

Validates that the collection is properly configured
Call this during development to catch configuration issues early

#### Returns

`void`
