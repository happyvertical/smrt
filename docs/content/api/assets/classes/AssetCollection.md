# Class: AssetCollection

Defined in: [assets/src/assets.ts:10](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/assets/src/assets.ts#L10)

## Extends

- `SmrtCollection`\<[`Asset`](Asset.md)\>

## Constructors

### Constructor

> `protected` **new AssetCollection**(`options?`): `AssetCollection`

Defined in: [core/dist/collection.d.ts:45](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/collection.d.ts#L45)

Creates a new SmrtCollection instance

#### Parameters

##### options?

`SmrtCollectionOptions`

Configuration options

#### Returns

`AssetCollection`

#### Deprecated

Use the static create() factory method instead

#### Inherited from

`SmrtCollection<Asset>.constructor`

## Properties

### \_ai

> `protected` **\_ai**: `AIClient`

Defined in: [core/dist/class.d.ts:75](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/class.d.ts#L75)

AI client instance for interacting with AI models

#### Inherited from

`SmrtCollection._ai`

***

### \_className

> `protected` **\_className**: `string`

Defined in: [core/dist/class.d.ts:87](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/class.d.ts#L87)

Class name used for identification

#### Inherited from

`SmrtCollection._className`

***

### \_db

> `protected` **\_db**: `DatabaseInterface`

Defined in: [core/dist/class.d.ts:83](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/class.d.ts#L83)

Database interface for data persistence

#### Inherited from

`SmrtCollection._db`

***

### \_db\_setup\_promise

> `protected` **\_db\_setup\_promise**: `Promise`\<`void`\> \| `null`

Defined in: [core/dist/collection.d.ts:19](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/collection.d.ts#L19)

Promise tracking the database setup operation

#### Inherited from

`SmrtCollection._db_setup_promise`

***

### \_fs

> `protected` **\_fs**: `FilesystemAdapter`

Defined in: [core/dist/class.d.ts:79](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/class.d.ts#L79)

Filesystem adapter for file operations

#### Inherited from

`SmrtCollection._fs`

***

### \_signalBus?

> `protected` `optional` **\_signalBus**: `SignalBus`

Defined in: [core/dist/class.d.ts:91](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/class.d.ts#L91)

Signal bus for method execution tracking

#### Inherited from

`SmrtCollection._signalBus`

***

### \_tableName

> **\_tableName**: `string`

Defined in: [core/dist/collection.d.ts:38](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/collection.d.ts#L38)

Database table name for this collection

#### Inherited from

`SmrtCollection._tableName`

***

### options

> `protected` **options**: `SmrtClassOptions`

Defined in: [core/dist/class.d.ts:99](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/class.d.ts#L99)

Configuration options provided to the class

#### Inherited from

`SmrtCollection.options`

***

### \_itemClass

> `readonly` `static` **\_itemClass**: *typeof* [`Asset`](Asset.md) = `Asset`

Defined in: [assets/src/assets.ts:11](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/assets/src/assets.ts#L11)

Static reference to the item class constructor

#### Overrides

`SmrtCollection._itemClass`

## Accessors

### \_itemClass

#### Get Signature

> **get** `protected` **\_itemClass**(): (`options`) => `ModelType` & `object`

Defined in: [core/dist/collection.d.ts:23](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/collection.d.ts#L23)

Gets the class constructor for items in this collection

##### Returns

(`options`) => `ModelType` & `object`

#### Inherited from

`SmrtCollection._itemClass`

***

### ai

#### Get Signature

> **get** **ai**(): `AIClient`

Defined in: [core/dist/class.d.ts:185](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/class.d.ts#L185)

Gets the AI client instance

##### Returns

`AIClient`

#### Inherited from

`SmrtCollection.ai`

***

### db

#### Get Signature

> **get** **db**(): `DatabaseInterface`

Defined in: [core/dist/class.d.ts:181](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/class.d.ts#L181)

Gets the database interface instance

##### Returns

`DatabaseInterface`

#### Inherited from

`SmrtCollection.db`

***

### fs

#### Get Signature

> **get** **fs**(): `FilesystemAdapter`

Defined in: [core/dist/class.d.ts:177](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/class.d.ts#L177)

Gets the filesystem adapter instance

##### Returns

`FilesystemAdapter`

#### Inherited from

`SmrtCollection.fs`

***

### signalBus

#### Get Signature

> **get** **signalBus**(): `SignalBus` \| `undefined`

Defined in: [core/dist/class.d.ts:191](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/class.d.ts#L191)

Gets the signal bus instance

##### Returns

`SignalBus` \| `undefined`

Signal bus if signals are enabled, undefined otherwise

#### Inherited from

`SmrtCollection.signalBus`

***

### systemDb

#### Get Signature

> **get** `protected` **systemDb**(): `DatabaseInterface`

Defined in: [core/dist/class.d.ts:142](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/class.d.ts#L142)

Access system tables through standard database interface
System tables use _smrt_ prefix to avoid conflicts with user tables

##### Returns

`DatabaseInterface`

#### Inherited from

`SmrtCollection.systemDb`

***

### tableName

#### Get Signature

> **get** **tableName**(): `string`

Defined in: [core/dist/collection.d.ts:217](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/collection.d.ts#L217)

Gets the database table name for this collection

##### Returns

`string`

#### Inherited from

`SmrtCollection.tableName`

## Methods

### addTag()

> **addTag**(`assetId`, `tagSlug`): `Promise`\<`void`\>

Defined in: [assets/src/assets.ts:19](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/assets/src/assets.ts#L19)

Add a tag to an asset (uses @smrt/tags)

#### Parameters

##### assetId

`string`

The asset ID to tag

##### tagSlug

`string`

The tag slug from @smrt/tags

#### Returns

`Promise`\<`void`\>

***

### count()

> **count**(`options?`): `Promise`\<`number`\>

Defined in: [core/dist/collection.d.ts:233](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/collection.d.ts#L233)

Counts records in the collection matching the given filters

Accepts the same where conditions as list() but ignores limit/offset/orderBy.

#### Parameters

##### options?

Query options object

###### where?

`Record`\<`string`, `any`\>

Record of conditions to filter results

#### Returns

`Promise`\<`number`\>

Promise resolving to the total count of matching records

#### Inherited from

`SmrtCollection.count`

***

### create()

> **create**(`options`): `Promise`\<[`Asset`](Asset.md)\>

Defined in: [core/dist/collection.d.ts:177](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/collection.d.ts#L177)

Creates a new instance of the collection's item class

#### Parameters

##### options

`any`

Options for creating the item

#### Returns

`Promise`\<[`Asset`](Asset.md)\>

New item instance

#### Inherited from

`SmrtCollection.create`

***

### createNewVersion()

> **createNewVersion**(`primaryVersionId`, `newSourceUri`, `updates`): `Promise`\<[`Asset`](Asset.md)\>

Defined in: [assets/src/assets.ts:100](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/assets/src/assets.ts#L100)

Create a new version of an existing asset

#### Parameters

##### primaryVersionId

`string`

The primary version ID (first version's ID)

##### newSourceUri

`string`

The new source URI for this version

##### updates

`Partial`\<[`Asset`](Asset.md)\> = `{}`

Optional additional updates

#### Returns

`Promise`\<[`Asset`](Asset.md)\>

The newly created asset version

***

### destroy()

> **destroy**(): `void`

Defined in: [core/dist/class.d.ts:207](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/class.d.ts#L207)

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

`SmrtCollection.destroy`

***

### forget()

> **forget**(`options`): `Promise`\<`void`\>

Defined in: [core/dist/collection.d.ts:334](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/collection.d.ts#L334)

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

#### Inherited from

`SmrtCollection.forget`

***

### forgetScope()

> **forgetScope**(`options`): `Promise`\<`number`\>

Defined in: [core/dist/collection.d.ts:354](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/collection.d.ts#L354)

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

#### Inherited from

`SmrtCollection.forgetScope`

***

### generateSchema()

> **generateSchema**(): `string`

Defined in: [core/dist/collection.d.ts:213](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/collection.d.ts#L213)

Generates database schema for the collection's item class

Leverages ObjectRegistry's cached schema for instant retrieval.

#### Returns

`string`

Schema object for database setup

#### Inherited from

`SmrtCollection.generateSchema`

***

### generateTableName()

> **generateTableName**(): `string`

Defined in: [core/dist/collection.d.ts:223](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/collection.d.ts#L223)

Generates a table name from the collection class name

#### Returns

`string`

Generated table name

#### Inherited from

`SmrtCollection.generateTableName`

***

### get()

> **get**(`filter`): `Promise`\<[`Asset`](Asset.md) \| `null`\>

Defined in: [core/dist/collection.d.ts:84](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/collection.d.ts#L84)

Retrieves a single object from the collection by ID, slug, or custom filter

#### Parameters

##### filter

String ID/slug or object with filter conditions

`string` | `Record`\<`string`, `any`\>

#### Returns

`Promise`\<[`Asset`](Asset.md) \| `null`\>

Promise resolving to the object or null if not found

#### Inherited from

`SmrtCollection.get`

***

### getByMimeType()

> **getByMimeType**(`mimePattern`): `Promise`\<[`Asset`](Asset.md)[]\>

Defined in: [assets/src/assets.ts:184](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/assets/src/assets.ts#L184)

Get assets by MIME type pattern

#### Parameters

##### mimePattern

`string`

MIME type pattern (e.g., 'image/*', 'video/mp4')

#### Returns

`Promise`\<[`Asset`](Asset.md)[]\>

Array of matching assets

***

### getByOwner()

> **getByOwner**(`ownerProfileId`): `Promise`\<[`Asset`](Asset.md)[]\>

Defined in: [assets/src/assets.ts:88](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/assets/src/assets.ts#L88)

Get assets by owner

#### Parameters

##### ownerProfileId

`string`

The profile ID of the owner

#### Returns

`Promise`\<[`Asset`](Asset.md)[]\>

Array of assets owned by this profile

***

### getByStatus()

> **getByStatus**(`statusSlug`): `Promise`\<[`Asset`](Asset.md)[]\>

Defined in: [assets/src/assets.ts:78](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/assets/src/assets.ts#L78)

Get assets by status

#### Parameters

##### statusSlug

`string`

The asset status slug (e.g., 'published', 'draft')

#### Returns

`Promise`\<[`Asset`](Asset.md)[]\>

Array of assets matching the status

***

### getByTag()

> **getByTag**(`tagSlug`): `Promise`\<[`Asset`](Asset.md)[]\>

Defined in: [assets/src/assets.ts:47](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/assets/src/assets.ts#L47)

Get all assets with a specific tag

#### Parameters

##### tagSlug

`string`

The tag slug to filter by

#### Returns

`Promise`\<[`Asset`](Asset.md)[]\>

Array of assets with this tag

***

### getByType()

> **getByType**(`typeSlug`): `Promise`\<[`Asset`](Asset.md)[]\>

Defined in: [assets/src/assets.ts:68](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/assets/src/assets.ts#L68)

Get assets by type

#### Parameters

##### typeSlug

`string`

The asset type slug (e.g., 'image', 'video')

#### Returns

`Promise`\<[`Asset`](Asset.md)[]\>

Array of assets matching the type

***

### getChildren()

> **getChildren**(`parentId`): `Promise`\<[`Asset`](Asset.md)[]\>

Defined in: [assets/src/assets.ts:174](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/assets/src/assets.ts#L174)

Get child assets (derivatives) of a parent asset

#### Parameters

##### parentId

`string`

The parent asset ID

#### Returns

`Promise`\<[`Asset`](Asset.md)[]\>

Array of child assets

***

### getDiff()

> **getDiff**(`existing`, `data`): `Record`\<`string`, `any`\>

Defined in: [core/dist/collection.d.ts:193](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/collection.d.ts#L193)

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

#### Inherited from

`SmrtCollection.getDiff`

***

### getFields()

> **getFields**(): `Record`\<`string`, `any`\>

Defined in: [core/dist/collection.d.ts:205](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/collection.d.ts#L205)

Gets field definitions for the collection's item class

#### Returns

`Record`\<`string`, `any`\>

Object containing field definitions

#### Inherited from

`SmrtCollection.getFields`

***

### getLatestVersion()

> **getLatestVersion**(`primaryVersionId`): `Promise`\<[`Asset`](Asset.md) \| `null`\>

Defined in: [assets/src/assets.ts:136](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/assets/src/assets.ts#L136)

Get the latest version of an asset

#### Parameters

##### primaryVersionId

`string`

The primary version ID

#### Returns

`Promise`\<[`Asset`](Asset.md) \| `null`\>

The latest version or null

***

### getOrUpsert()

> **getOrUpsert**(`data`, `defaults?`): `Promise`\<[`Asset`](Asset.md)\>

Defined in: [core/dist/collection.d.ts:185](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/collection.d.ts#L185)

Gets an existing item or creates a new one if it doesn't exist

#### Parameters

##### data

`any`

Object data to find or create

##### defaults?

`any`

Default values to use if creating a new object

#### Returns

`Promise`\<[`Asset`](Asset.md)\>

Promise resolving to the existing or new object

#### Inherited from

`SmrtCollection.getOrUpsert`

***

### initialize()

> **initialize**(): `Promise`\<`AssetCollection`\>

Defined in: [core/dist/collection.d.ts:77](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/collection.d.ts#L77)

Initializes the collection, setting up database tables

#### Returns

`Promise`\<`AssetCollection`\>

Promise that resolves to this instance for chaining

#### Inherited from

`SmrtCollection.initialize`

***

### list()

> **list**(`options`): `Promise`\<[`Asset`](Asset.md)[]\>

Defined in: [core/dist/collection.d.ts:124](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/collection.d.ts#L124)

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

`Promise`\<[`Asset`](Asset.md)[]\>

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

#### Inherited from

`SmrtCollection.list`

***

### listVersions()

> **listVersions**(`primaryVersionId`): `Promise`\<[`Asset`](Asset.md)[]\>

Defined in: [assets/src/assets.ts:151](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/assets/src/assets.ts#L151)

List all versions of an asset

#### Parameters

##### primaryVersionId

`string`

The primary version ID

#### Returns

`Promise`\<[`Asset`](Asset.md)[]\>

Array of all asset versions, ordered by version number

***

### recall()

> **recall**(`options`): `Promise`\<`any`\>

Defined in: [core/dist/collection.d.ts:291](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/collection.d.ts#L291)

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

#### Inherited from

`SmrtCollection.recall`

***

### recallAll()

> **recallAll**(`options?`): `Promise`\<`Map`\<`string`, `any`\>\>

Defined in: [core/dist/collection.d.ts:313](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/collection.d.ts#L313)

Recall all collection-level context in a scope

Returns a Map of key -> value for all collection contexts matching the criteria.

#### Parameters

##### options?

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

#### Inherited from

`SmrtCollection.recallAll`

***

### remember()

> **remember**(`options`): `Promise`\<`void`\>

Defined in: [core/dist/collection.d.ts:264](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/collection.d.ts#L264)

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

#### Inherited from

`SmrtCollection.remember`

***

### removeTag()

> **removeTag**(`assetId`, `tagSlug`): `Promise`\<`void`\>

Defined in: [assets/src/assets.ts:34](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/assets/src/assets.ts#L34)

Remove a tag from an asset

#### Parameters

##### assetId

`string`

The asset ID

##### tagSlug

`string`

The tag slug to remove

#### Returns

`Promise`\<`void`\>

***

### setupDb()

> **setupDb**(): `Promise`\<`void`\>

Defined in: [core/dist/collection.d.ts:199](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/collection.d.ts#L199)

Sets up the database schema for this collection

#### Returns

`Promise`\<`void`\>

Promise that resolves when setup is complete

#### Inherited from

`SmrtCollection.setupDb`

***

### create()

> `static` **create**\<`T`\>(`this`, `options?`): `Promise`\<`any`\>

Defined in: [core/dist/collection.d.ts:71](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/collection.d.ts#L71)

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

##### options?

`SmrtClassOptions`

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

#### Inherited from

`SmrtCollection.create`

***

### validate()

> `static` **validate**(): `void`

Defined in: [core/dist/collection.d.ts:34](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/collection.d.ts#L34)

Validates that the collection is properly configured
Call this during development to catch configuration issues early

#### Returns

`void`

#### Inherited from

`SmrtCollection.validate`
