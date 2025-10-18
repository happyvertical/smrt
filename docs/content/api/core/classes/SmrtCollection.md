# Class: SmrtCollection\<ModelType\>

Defined in: [smrt/packages/core/src/collection.ts:26](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/collection.ts#L26)

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

Defined in: [smrt/packages/core/src/collection.ts:118](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/collection.ts#L118)

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

Defined in: [smrt/packages/core/src/class.ts:97](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/class.ts#L97)

AI client instance for interacting with AI models

#### Inherited from

[`SmrtClass`](SmrtClass.md).[`_ai`](SmrtClass.md#_ai)

***

### \_className

> `protected` **\_className**: `string`

Defined in: [smrt/packages/core/src/class.ts:112](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/class.ts#L112)

Class name used for identification

#### Inherited from

[`SmrtClass`](SmrtClass.md).[`_className`](SmrtClass.md#_classname)

***

### \_db

> `protected` **\_db**: `DatabaseInterface`

Defined in: [smrt/packages/core/src/class.ts:107](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/class.ts#L107)

Database interface for data persistence

#### Inherited from

[`SmrtClass`](SmrtClass.md).[`_db`](SmrtClass.md#_db)

***

### \_db\_setup\_promise

> `protected` **\_db\_setup\_promise**: `Promise`\<`void`\> \| `null` = `null`

Defined in: [smrt/packages/core/src/collection.ts:30](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/collection.ts#L30)

Promise tracking the database setup operation

***

### \_fs

> `protected` **\_fs**: `FilesystemAdapter`

Defined in: [smrt/packages/core/src/class.ts:102](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/class.ts#L102)

Filesystem adapter for file operations

#### Inherited from

[`SmrtClass`](SmrtClass.md).[`_fs`](SmrtClass.md#_fs)

***

### \_signalBus?

> `protected` `optional` **\_signalBus**: [`SignalBus`](SignalBus.md)

Defined in: [smrt/packages/core/src/class.ts:117](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/class.ts#L117)

Signal bus for method execution tracking

#### Inherited from

[`SmrtClass`](SmrtClass.md).[`_signalBus`](SmrtClass.md#_signalbus)

***

### \_tableName

> **\_tableName**: `string`

Defined in: [smrt/packages/core/src/collection.ts:110](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/collection.ts#L110)

Database table name for this collection

***

### options

> `protected` **options**: [`SmrtClassOptions`](../interfaces/SmrtClassOptions.md)

Defined in: [smrt/packages/core/src/class.ts:127](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/class.ts#L127)

Configuration options provided to the class

#### Inherited from

[`SmrtClass`](SmrtClass.md).[`options`](SmrtClass.md#options)

***

### \_itemClass

> `readonly` `static` **\_itemClass**: `any`

Defined in: [smrt/packages/core/src/collection.ts:68](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/collection.ts#L68)

Static reference to the item class constructor

## Accessors

### \_itemClass

#### Get Signature

> **get** `protected` **\_itemClass**(): (`options`) => `ModelType` & `object`

Defined in: [smrt/packages/core/src/collection.ts:35](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/collection.ts#L35)

Gets the class constructor for items in this collection

##### Returns

(`options`) => `ModelType` & `object`

***

### ai

#### Get Signature

> **get** **ai**(): `AIClient`

Defined in: [smrt/packages/core/src/class.ts:388](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/class.ts#L388)

Gets the AI client instance

##### Returns

`AIClient`

#### Inherited from

[`Pleb`](Pleb.md).[`ai`](Pleb.md#ai)

***

### db

#### Get Signature

> **get** **db**(): `DatabaseInterface`

Defined in: [smrt/packages/core/src/class.ts:381](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/class.ts#L381)

Gets the database interface instance

##### Returns

`DatabaseInterface`

#### Inherited from

[`Pleb`](Pleb.md).[`db`](Pleb.md#db)

***

### fs

#### Get Signature

> **get** **fs**(): `FilesystemAdapter`

Defined in: [smrt/packages/core/src/class.ts:374](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/class.ts#L374)

Gets the filesystem adapter instance

##### Returns

`FilesystemAdapter`

#### Inherited from

[`Pleb`](Pleb.md).[`fs`](Pleb.md#fs)

***

### signalBus

#### Get Signature

> **get** **signalBus**(): [`SignalBus`](SignalBus.md) \| `undefined`

Defined in: [smrt/packages/core/src/class.ts:397](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/class.ts#L397)

Gets the signal bus instance

##### Returns

[`SignalBus`](SignalBus.md) \| `undefined`

Signal bus if signals are enabled, undefined otherwise

#### Inherited from

[`Pleb`](Pleb.md).[`signalBus`](Pleb.md#signalbus)

***

### systemDb

#### Get Signature

> **get** `protected` **systemDb**(): `DatabaseInterface`

Defined in: [smrt/packages/core/src/class.ts:255](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/class.ts#L255)

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

Defined in: [smrt/packages/core/src/collection.ts:668](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/collection.ts#L668)

Gets the database table name for this collection

##### Returns

`string`

## Methods

### count()

> **count**(`options`): `Promise`\<`number`\>

Defined in: [smrt/packages/core/src/collection.ts:704](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/collection.ts#L704)

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

Defined in: [smrt/packages/core/src/collection.ts:547](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/collection.ts#L547)

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

Defined in: [smrt/packages/core/src/class.ts:416](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/class.ts#L416)

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

### forget()

> **forget**(`options`): `Promise`\<`void`\>

Defined in: [smrt/packages/core/src/collection.ts:932](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/collection.ts#L932)

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

Defined in: [smrt/packages/core/src/collection.ts:963](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/collection.ts#L963)

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

> **generateSchema**(): `string`

Defined in: [smrt/packages/core/src/collection.ts:660](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/collection.ts#L660)

Generates database schema for the collection's item class

Leverages ObjectRegistry's cached schema for instant retrieval.

#### Returns

`string`

Schema object for database setup

***

### generateTableName()

> **generateTableName**(): `string`

Defined in: [smrt/packages/core/src/collection.ts:680](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/collection.ts#L680)

Generates a table name from the collection class name

#### Returns

`string`

Generated table name

***

### get()

> **get**(`filter`): `Promise`\<`ModelType` \| `null`\>

Defined in: [smrt/packages/core/src/collection.ts:218](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/collection.ts#L218)

Retrieves a single object from the collection by ID, slug, or custom filter

#### Parameters

##### filter

String ID/slug or object with filter conditions

`string` | `Record`\<`string`, `any`\>

#### Returns

`Promise`\<`ModelType` \| `null`\>

Promise resolving to the object or null if not found

***

### getDiff()

> **getDiff**(`existing`, `data`): `Record`\<`string`, `any`\>

Defined in: [smrt/packages/core/src/collection.ts:601](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/collection.ts#L601)

Gets differences between an existing object and new data

#### Parameters

##### existing

`Record`\<`string`, `any`\>

Existing object

##### data

`Record`\<`string`, `any`\>

New data

#### Returns

`Record`\<`string`, `any`\>

Object containing only the changed fields

***

### getFields()

> **getFields**(): `Record`\<`string`, `any`\>

Defined in: [smrt/packages/core/src/collection.ts:649](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/collection.ts#L649)

Gets field definitions for the collection's item class

#### Returns

`Record`\<`string`, `any`\>

Object containing field definitions

***

### getOrUpsert()

> **getOrUpsert**(`data`, `defaults`): `Promise`\<`ModelType`\>

Defined in: [smrt/packages/core/src/collection.ts:568](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/collection.ts#L568)

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

Defined in: [smrt/packages/core/src/collection.ts:201](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/collection.ts#L201)

Initializes the collection, setting up database tables

#### Returns

`Promise`\<`SmrtCollection`\<`ModelType`\>\>

Promise that resolves to this instance for chaining

#### Overrides

[`SmrtClass`](SmrtClass.md).[`initialize`](SmrtClass.md#initialize)

***

### list()

> **list**(`options`): `Promise`\<`Awaited`\<`ModelType`\>[]\>

Defined in: [smrt/packages/core/src/collection.ts:280](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/collection.ts#L280)

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

`Promise`\<`Awaited`\<`ModelType`\>[]\>

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

Defined in: [smrt/packages/core/src/collection.ts:799](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/collection.ts#L799)

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

Defined in: [smrt/packages/core/src/collection.ts:870](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/collection.ts#L870)

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

Defined in: [smrt/packages/core/src/collection.ts:744](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/collection.ts#L744)

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

### setupDb()

> **setupDb**(): `Promise`\<`void`\>

Defined in: [smrt/packages/core/src/collection.ts:622](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/collection.ts#L622)

Sets up the database schema for this collection

#### Returns

`Promise`\<`void`\>

Promise that resolves when setup is complete

***

### create()

> `static` **create**\<`T`\>(`this`, `options`): `Promise`\<`any`\>

Defined in: [smrt/packages/core/src/collection.ts:156](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/collection.ts#L156)

Static factory method for creating fully initialized collection instances

This is the recommended way to create collections. It accepts broad option types
(SmrtClassOptions) and handles option extraction internally, then returns a
fully initialized, ready-to-use collection instance.

TypeScript Note: Uses InstanceType<T> to preserve subclass types through the
static factory method, ensuring custom collection methods are properly typed.

#### Type Parameters

##### T

`T` *extends* *typeof* `SmrtCollection`

#### Parameters

##### this

`T`

##### options

[`SmrtClassOptions`](../interfaces/SmrtClassOptions.md) = `{}`

Configuration options (accepts both SmrtClassOptions and SmrtCollectionOptions)

#### Returns

`Promise`\<`any`\>

Promise resolving to a fully initialized collection instance

#### Example

```typescript
// Create collection from object options
const collection = await (ProductCollection as any).create(smrtObject.options);

// Create collection with specific config
const collection = await (ProductCollection as any).create({
  persistence: { type: 'sql', url: 'products.db' },
  ai: { provider: 'openai', apiKey: process.env.OPENAI_API_KEY }
});
```

***

### validate()

> `static` **validate**(): `void`

Defined in: [smrt/packages/core/src/collection.ts:74](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/collection.ts#L74)

Validates that the collection is properly configured
Call this during development to catch configuration issues early

#### Returns

`void`
