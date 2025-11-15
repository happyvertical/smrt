# Class: ProfileMetafield

Defined in: [profiles/src/models/ProfileMetafield.ts:34](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/profiles/src/models/ProfileMetafield.ts#L34)

## Extends

- `SmrtObject`

## Constructors

### Constructor

> **new ProfileMetafield**(`options`): `ProfileMetafield`

Defined in: [profiles/src/models/ProfileMetafield.ts:41](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/profiles/src/models/ProfileMetafield.ts#L41)

#### Parameters

##### options

[`ProfileMetafieldOptions`](../interfaces/ProfileMetafieldOptions.md) = `{}`

#### Returns

`ProfileMetafield`

#### Overrides

`SmrtObject.constructor`

## Properties

### \_ai

> `protected` **\_ai**: `AIClient`

Defined in: core/dist/class.d.ts:86

AI client instance for interacting with AI models

#### Inherited from

`SmrtObject._ai`

***

### \_className

> `protected` **\_className**: `string`

Defined in: core/dist/class.d.ts:98

Class name used for identification

#### Inherited from

`SmrtObject._className`

***

### \_context

> `protected` **\_context**: `string` \| `null` \| `undefined`

Defined in: core/dist/object.d.ts:79

Optional context to scope the slug

#### Inherited from

`SmrtObject._context`

***

### \_db

> `protected` **\_db**: `DatabaseInterface`

Defined in: core/dist/class.d.ts:94

Database interface for data persistence

#### Inherited from

`SmrtObject._db`

***

### \_fs

> `protected` **\_fs**: `FilesystemAdapter`

Defined in: core/dist/class.d.ts:90

Filesystem adapter for file operations

#### Inherited from

`SmrtObject._fs`

***

### \_id

> `protected` **\_id**: `string` \| `null` \| `undefined`

Defined in: core/dist/object.d.ts:71

Unique identifier for the object

#### Inherited from

`SmrtObject._id`

***

### \_signalBus?

> `protected` `optional` **\_signalBus**: `SignalBus`

Defined in: core/dist/class.d.ts:102

Signal bus for method execution tracking

#### Inherited from

`SmrtObject._signalBus`

***

### \_slug

> `protected` **\_slug**: `string` \| `null` \| `undefined`

Defined in: core/dist/object.d.ts:75

URL-friendly identifier

#### Inherited from

`SmrtObject._slug`

***

### \_tableName

> **\_tableName**: `string`

Defined in: core/dist/object.d.ts:52

Database table name for this object

#### Inherited from

`SmrtObject._tableName`

***

### created\_at

> **created\_at**: `Date` \| `null` \| `undefined`

Defined in: core/dist/object.d.ts:83

Creation timestamp

#### Inherited from

`SmrtObject.created_at`

***

### description?

> `optional` **description**: `Field`

Defined in: [profiles/src/models/ProfileMetafield.ts:38](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/profiles/src/models/ProfileMetafield.ts#L38)

***

### name

> **name**: `Field`

Defined in: [profiles/src/models/ProfileMetafield.ts:37](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/profiles/src/models/ProfileMetafield.ts#L37)

***

### options

> **options**: `SmrtObjectOptions`

Defined in: core/dist/object.d.ts:67

Override options with SmrtObjectOptions type for proper type narrowing.
Initialized by parent constructor via super() call.

#### Inherited from

`SmrtObject.options`

***

### updated\_at

> **updated\_at**: `Date` \| `null` \| `undefined`

Defined in: core/dist/object.d.ts:87

Last update timestamp

#### Inherited from

`SmrtObject.updated_at`

***

### validation?

> `optional` **validation**: `Field`

Defined in: [profiles/src/models/ProfileMetafield.ts:39](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/profiles/src/models/ProfileMetafield.ts#L39)

## Accessors

### ai

#### Get Signature

> **get** **ai**(): `AIClient`

Defined in: core/dist/class.d.ts:211

Gets the AI client instance

##### Returns

`AIClient`

#### Inherited from

`SmrtObject.ai`

***

### context

#### Get Signature

> **get** **context**(): `string`

Defined in: core/dist/object.d.ts:142

Gets the context that scopes this object's slug

##### Returns

`string`

#### Set Signature

> **set** **context**(`value`): `void`

Defined in: core/dist/object.d.ts:149

Sets the context that scopes this object's slug

##### Throws

Error if the value is invalid

##### Parameters

###### value

The context to set

`string` | `null` | `undefined`

##### Returns

`void`

#### Inherited from

`SmrtObject.context`

***

### db

#### Get Signature

> **get** **db**(): `DatabaseInterface`

Defined in: core/dist/class.d.ts:207

Gets the database interface instance

##### Returns

`DatabaseInterface`

#### Inherited from

`SmrtObject.db`

***

### fs

#### Get Signature

> **get** **fs**(): `FilesystemAdapter`

Defined in: core/dist/class.d.ts:203

Gets the filesystem adapter instance

##### Returns

`FilesystemAdapter`

#### Inherited from

`SmrtObject.fs`

***

### id

#### Get Signature

> **get** **id**(): `string` \| `null` \| `undefined`

Defined in: core/dist/object.d.ts:120

Gets the unique identifier for this object

##### Returns

`string` \| `null` \| `undefined`

#### Set Signature

> **set** **id**(`value`): `void`

Defined in: core/dist/object.d.ts:127

Sets the unique identifier for this object

##### Throws

Error if the value is invalid

##### Parameters

###### value

The ID to set

`string` | `null` | `undefined`

##### Returns

`void`

#### Inherited from

`SmrtObject.id`

***

### signalBus

#### Get Signature

> **get** **signalBus**(): `SignalBus` \| `undefined`

Defined in: core/dist/class.d.ts:217

Gets the signal bus instance

##### Returns

`SignalBus` \| `undefined`

Signal bus if signals are enabled, undefined otherwise

#### Inherited from

`SmrtObject.signalBus`

***

### slug

#### Get Signature

> **get** **slug**(): `string` \| `null` \| `undefined`

Defined in: core/dist/object.d.ts:131

Gets the URL-friendly slug for this object

##### Returns

`string` \| `null` \| `undefined`

#### Set Signature

> **set** **slug**(`value`): `void`

Defined in: core/dist/object.d.ts:138

Sets the URL-friendly slug for this object

##### Throws

Error if the value is invalid

##### Parameters

###### value

The slug to set

`string` | `null` | `undefined`

##### Returns

`void`

#### Inherited from

`SmrtObject.slug`

***

### systemDb

#### Get Signature

> **get** `protected` **systemDb**(): `DatabaseInterface`

Defined in: core/dist/class.d.ts:168

Access system tables through standard database interface
System tables use _smrt_ prefix to avoid conflicts with user tables

##### Returns

`DatabaseInterface`

#### Inherited from

`SmrtObject.systemDb`

***

### tableName

#### Get Signature

> **get** **tableName**(): `string`

Defined in: core/dist/object.d.ts:191

Gets the database table name for this object

##### Returns

`string`

#### Inherited from

`SmrtObject.tableName`

## Methods

### allDescriptors()

> **allDescriptors**(): `object` & `object`

Defined in: core/dist/object.d.ts:183

Gets all property descriptors from this object's prototype

#### Returns

`object` & `object`

Object containing all property descriptors

#### Inherited from

`SmrtObject.allDescriptors`

***

### delete()

> **delete**(): `Promise`\<`void`\>

Defined in: core/dist/object.d.ts:331

Delete this object from the database

#### Returns

`Promise`\<`void`\>

Promise that resolves when deletion is complete

#### Inherited from

`SmrtObject.delete`

***

### describe()

> **describe**(`options?`): `Promise`\<`string`\>

Defined in: core/dist/object.d.ts:318

Generates a description of this object using AI (Issue #52)

Creates a concise, human-readable description based on the object's content
and properties. Useful for summaries, previews, and documentation.

#### Parameters

##### options?

`any`

AI message options (can include style, length, focus, etc.)

#### Returns

`Promise`\<`string`\>

Promise resolving to the AI-generated description

#### Example

```typescript
const product = await products.get('product-123');
const description = await product.describe();
// "A high-quality widget for home improvement..."

// With custom options
const shortDesc = await product.describe({ maxTokens: 50 });
// "Premium widget, steel construction"
```

#### Inherited from

`SmrtObject.describe`

***

### destroy()

> **destroy**(): `void`

Defined in: core/dist/class.d.ts:233

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

`SmrtObject.destroy`

***

### do()

> **do**(`instructions`, `options?`): `Promise`\<`string`\>

Defined in: core/dist/object.d.ts:297

Performs actions on this object based on instructions using AI

#### Parameters

##### instructions

`string`

Instructions for the AI to follow

##### options?

`any`

AI message options

#### Returns

`Promise`\<`string`\>

Promise resolving to the AI response

#### Inherited from

`SmrtObject.do`

***

### ensureDbSetup()

> `protected` **ensureDbSetup**(): `Promise`\<`void`\>

Defined in: core/dist/object.d.ts:166

Ensures database tables are set up before performing database operations

This method implements lazy initialization - tables are created on first use
rather than during initialize(). This prevents database connections during
import/prerendering phases (issue #237).

 - Available for custom methods that need direct database access

#### Returns

`Promise`\<`void`\>

Promise that resolves when setup is complete

#### Inherited from

`SmrtObject.ensureDbSetup`

***

### executeToolCall()

> **executeToolCall**(`toolCall`): `Promise`\<`ToolCallResult`\>

Defined in: core/dist/object.d.ts:434

Execute a tool call from AI on this object instance

Validates the tool call against allowed methods and executes it with
proper error handling and timing.

#### Parameters

##### toolCall

`ToolCall`

Tool call from AI response

#### Returns

`Promise`\<`ToolCallResult`\>

Promise resolving to the tool call result

#### Example

```typescript
const toolCall = {
  id: 'call_123',
  type: 'function',
  function: {
    name: 'analyze',
    arguments: '{"type": "detailed"}'
  }
};

const result = await document.executeToolCall(toolCall);
console.log(result.success ? result.result : result.error);
```

#### Inherited from

`SmrtObject.executeToolCall`

***

### extractConstraintField()

> `protected` **extractConstraintField**(`errorMessage`): `string`

Defined in: core/dist/object.d.ts:268

Extracts field name from database constraint error messages

#### Parameters

##### errorMessage

`string`

#### Returns

`string`

#### Inherited from

`SmrtObject.extractConstraintField`

***

### forget()

> **forget**(`options`): `Promise`\<`void`\>

Defined in: core/dist/object.d.ts:542

Forget specific remembered context for this object

Deletes context by scope and key. Use for invalidating cached strategies
or removing outdated patterns.

#### Parameters

##### options

Context identification (scope and key required)

###### key

`string`

###### scope

`string`

#### Returns

`Promise`\<`void`\>

Promise that resolves when context is deleted

#### Example

```typescript
// Remove an outdated strategy
await agent.forget({
  scope: 'discovery/parser/example.com',
  key: normalizedUrl
});
```

#### Inherited from

`SmrtObject.forget`

***

### forgetScope()

> **forgetScope**(`options`): `Promise`\<`number`\>

Defined in: core/dist/object.d.ts:564

Forget all remembered context in a scope for this object

Deletes all context matching the scope pattern. Useful for clearing
cached strategies for an entire domain or category.

#### Parameters

##### options

Scope options (scope required, includeDescendants optional)

###### includeDescendants?

`boolean`

###### scope

`string`

#### Returns

`Promise`\<`number`\>

Promise resolving to number of contexts deleted

#### Example

```typescript
// Clear all strategies for a domain
const count = await agent.forgetScope({
  scope: 'discovery/parser/example.com',
  includeDescendants: true
});
console.log(`Cleared ${count} cached strategies`);
```

#### Inherited from

`SmrtObject.forgetScope`

***

### getAvailableTools()

> **getAvailableTools**(): `AITool`[]

Defined in: core/dist/object.d.ts:410

Get available AI-callable tools for this object

Returns the pre-generated tool definitions from the manifest.
Tools are generated at build time based on the

#### Returns

`AITool`[]

Array of AITool definitions for LLM function calling

#### Smrt

decorator's AI config.

#### Example

```typescript
const tools = document.getAvailableTools();
console.log(`${tools.length} AI-callable methods available`);
```

#### Inherited from

`SmrtObject.getAvailableTools`

***

### getFields()

> **getFields**(): `Promise`\<`Record`\<`string`, `any`\>\>

Defined in: core/dist/object.d.ts:197

Gets field definitions and current values for this object

#### Returns

`Promise`\<`Record`\<`string`, `any`\>\>

Object containing field definitions with current values

#### Inherited from

`SmrtObject.getFields`

***

### getFieldValue()

> `protected` **getFieldValue**(`fieldName`): `any`

Defined in: core/dist/object.d.ts:253

Gets the value of a field on this object

#### Parameters

##### fieldName

`string`

#### Returns

`any`

#### Inherited from

`SmrtObject.getFieldValue`

***

### getId()

> **getId**(): `Promise`\<`string`\>

Defined in: core/dist/object.d.ts:218

Gets or generates a unique ID for this object

#### Returns

`Promise`\<`string`\>

Promise resolving to the object's ID

#### Inherited from

`SmrtObject.getId`

***

### getPropertyValue()

> `protected` **getPropertyValue**(`key`): `any`

Defined in: core/dist/object.d.ts:264

Gets the actual value from a property, whether it's a plain value or a Field instance

Handles both simple and advanced field patterns:
- Simple: `name: string = ''` - returns the string directly
- Advanced: `name = text()` - extracts and returns field.value

#### Parameters

##### key

`string`

Property name to extract value from

#### Returns

`any`

The actual value (unwrapped from Field if necessary)

#### Inherited from

`SmrtObject.getPropertyValue`

***

### getRelated()

> **getRelated**(`fieldName`): `Promise`\<`any`\>

Defined in: core/dist/object.d.ts:396

Get a related object, loading it if not already loaded

Convenience method that checks if the relationship is loaded and
loads it if necessary. Automatically detects foreignKey vs oneToMany/manyToMany.

#### Parameters

##### fieldName

`string`

Name of the relationship field

#### Returns

`Promise`\<`any`\>

Promise resolving to the related object(s)

#### Example

```typescript
// Loads customer if not already loaded
const customer = await order.getRelated('customerId');

// Loads orders if not already loaded
const orders = await customer.getRelated('orders');
```

#### Inherited from

`SmrtObject.getRelated`

***

### getSavedId()

> **getSavedId**(): `Promise`\<`any`\>

Defined in: core/dist/object.d.ts:232

Gets the ID of this object if it's already saved in the database

#### Returns

`Promise`\<`any`\>

Promise resolving to the saved ID or null if not saved

#### Inherited from

`SmrtObject.getSavedId`

***

### getSlug()

> **getSlug**(): `Promise`\<`string` \| `null` \| `undefined`\>

Defined in: core/dist/object.d.ts:226

Gets or generates a slug for this object

Fallback order: name → title → label → id

#### Returns

`Promise`\<`string` \| `null` \| `undefined`\>

Promise resolving to the object's slug

#### Inherited from

`SmrtObject.getSlug`

***

### initialize()

> **initialize**(): `Promise`\<`ProfileMetafield`\>

Defined in: core/dist/object.d.ts:155

Initializes this object, setting up database tables and loading data if identifiers are provided

#### Returns

`Promise`\<`ProfileMetafield`\>

Promise that resolves to this instance for chaining

#### Inherited from

`SmrtObject.initialize`

***

### is()

> **is**(`criteria`, `options?`): `Promise`\<`any`\>

Defined in: core/dist/object.d.ts:289

Evaluates whether this object meets given criteria using AI

#### Parameters

##### criteria

`string`

Criteria to evaluate against

##### options?

`any`

AI message options

#### Returns

`Promise`\<`any`\>

Promise resolving to true if criteria are met, false otherwise

#### Throws

Error if the AI response is invalid

#### Inherited from

`SmrtObject.is`

***

### isRelatedLoaded()

> **isRelatedLoaded**(`fieldName`): `boolean`

Defined in: core/dist/object.d.ts:344

Check if a relationship has been loaded

#### Parameters

##### fieldName

`string`

Name of the relationship field

#### Returns

`boolean`

True if the relationship is loaded, false otherwise

#### Example

```typescript
if (order.isRelatedLoaded('customer')) {
  console.log('Customer already loaded');
}
```

#### Inherited from

`SmrtObject.isRelatedLoaded`

***

### isSaved()

> **isSaved**(): `Promise`\<`boolean`\>

Defined in: core/dist/object.d.ts:238

Checks if this object is already saved in the database

#### Returns

`Promise`\<`boolean`\>

Promise resolving to true if saved, false otherwise

#### Inherited from

`SmrtObject.isSaved`

***

### loadDataFromDb()

> **loadDataFromDb**(`data`): `Promise`\<`void`\>

Defined in: core/dist/object.d.ts:177

Loads data from a database row into this object's properties

STI Support: If using Single Table Inheritance (tableStrategy: 'sti'):
- Merges _meta_data JSONB fields into the main data object
- Validates _meta_type discriminator matches class name

#### Parameters

##### data

`any`

Database row data

#### Returns

`Promise`\<`void`\>

#### Throws

Error if STI validation fails

#### Inherited from

`SmrtObject.loadDataFromDb`

***

### loadFromId()

> **loadFromId**(): `Promise`\<`void`\>

Defined in: core/dist/object.d.ts:274

Loads this object's data from the database using its ID

#### Returns

`Promise`\<`void`\>

Promise that resolves when loading is complete

#### Inherited from

`SmrtObject.loadFromId`

***

### loadFromSlug()

> **loadFromSlug**(): `Promise`\<`void`\>

Defined in: core/dist/object.d.ts:280

Loads this object's data from the database using its slug and context

#### Returns

`Promise`\<`void`\>

Promise that resolves when loading is complete

#### Inherited from

`SmrtObject.loadFromSlug`

***

### loadRelated()

> **loadRelated**(`fieldName`): `Promise`\<`any`\>

Defined in: core/dist/object.d.ts:361

Load a related object for a foreignKey field (lazy loading)

Automatically loads the related object from the database using the
foreign key value. The loaded object is cached to avoid repeated queries.

#### Parameters

##### fieldName

`string`

Name of the foreignKey field

#### Returns

`Promise`\<`any`\>

Promise resolving to the related object or null if not found

#### Throws

If the field is not a foreignKey or target class not found

#### Example

```typescript
// Given: class Order with customerId = foreignKey(Customer)
const customer = await order.loadRelated('customerId');
console.log(customer.name); // Access customer properties
```

#### Inherited from

`SmrtObject.loadRelated`

***

### loadRelatedMany()

> **loadRelatedMany**(`fieldName`): `Promise`\<`any`[]\>

Defined in: core/dist/object.d.ts:378

Load related objects for oneToMany or manyToMany fields (lazy loading)

Loads all related objects from the database. For oneToMany, queries by
the inverse foreign key. For manyToMany, queries through the join table.

#### Parameters

##### fieldName

`string`

Name of the oneToMany or manyToMany field

#### Returns

`Promise`\<`any`[]\>

Promise resolving to array of related objects

#### Throws

If the field is not a relationship or not implemented

#### Example

```typescript
// Given: class Customer with orders = oneToMany(Order)
const orders = await customer.loadRelatedMany('orders');
console.log(`${orders.length} orders found`);
```

#### Inherited from

`SmrtObject.loadRelatedMany`

***

### recall()

> **recall**(`options`): `Promise`\<`any`\>

Defined in: core/dist/object.d.ts:493

Recall remembered context for this object

Retrieves context values with hierarchical search and confidence filtering.
Returns only the value (parsed from JSON if applicable).

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
// Recall a strategy with fallback to parent scopes
const strategy = await agent.recall({
  scope: 'discovery/parser/example.com/article',
  key: normalizedUrl,
  includeAncestors: true,
  minConfidence: 0.6
});
```

#### Inherited from

`SmrtObject.recall`

***

### recallAll()

> **recallAll**(`options?`): `Promise`\<`Map`\<`string`, `any`\>\>

Defined in: core/dist/object.d.ts:520

Recall all remembered context for this object in a scope

Returns a Map of key -> value for all context matching the criteria.
Useful for bulk retrieval of strategies or cached patterns.

#### Parameters

##### options?

Recall options without key (returns all keys in scope)

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
// Get all strategies for a domain
const strategies = await agent.recallAll({
  scope: 'discovery/parser/example.com',
  minConfidence: 0.5
});

for (const [url, pattern] of strategies) {
  console.log(`Cached pattern for ${url}:`, pattern);
}
```

#### Inherited from

`SmrtObject.recallAll`

***

### remember()

> **remember**(`options`): `Promise`\<`void`\>

Defined in: core/dist/object.d.ts:464

Remember context about this object

Stores hierarchical context with confidence tracking for learned patterns.
Context is stored in the _smrt_contexts system table.

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
// Remember a discovered parsing strategy
await agent.remember({
  scope: 'discovery/parser/example.com',
  key: normalizedUrl,
  value: { patterns: ['regex1', 'regex2'] },
  metadata: { aiProvider: 'openai' },
  confidence: 0.9
});

// Update an existing context entry by specifying id
await agent.remember({
  id: 'existing-context-id',
  scope: 'discovery/parser/example.com',
  key: normalizedUrl,
  value: { patterns: ['regex1', 'regex2', 'regex3'] },
  confidence: 0.95
});
```

#### Inherited from

`SmrtObject.remember`

***

### requiresDatabase()

> `protected` **requiresDatabase**(): `boolean`

Defined in: core/dist/class.d.ts:140

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

`SmrtObject.requiresDatabase`

***

### runHook()

> `protected` **runHook**(`hookName`): `Promise`\<`void`\>

Defined in: core/dist/object.d.ts:325

Runs a lifecycle hook if it's defined in the object's configuration

#### Parameters

##### hookName

`string`

Name of the hook to run (e.g., 'beforeDelete', 'afterDelete')

#### Returns

`Promise`\<`void`\>

Promise that resolves when the hook completes

#### Inherited from

`SmrtObject.runHook`

***

### save()

> **save**(): `Promise`\<`ProfileMetafield`\>

Defined in: core/dist/object.d.ts:244

Saves this object to the database

#### Returns

`Promise`\<`ProfileMetafield`\>

Promise resolving to this object

#### Inherited from

`SmrtObject.save`

***

### toJSON()

> **toJSON**(): `any`

Defined in: core/dist/object.d.ts:212

Custom JSON serialization
Returns a plain object with all field values for proper JSON.stringify() behavior
Field instances automatically call their toJSON() method during serialization

Issue #205: Filters out undefined values to prevent database errors

Note: This method cannot be async because JSON.stringify() expects synchronous toJSON()
It uses direct property access instead of getFields() to avoid async issues

STI Support: If using Single Table Inheritance (tableStrategy: 'sti'):
- Sets _meta_type discriminator to class name
- Extracts meta fields to _meta_data JSONB column

#### Returns

`any`

#### Inherited from

`SmrtObject.toJSON`

***

### validateBeforeSave()

> `protected` **validateBeforeSave**(): `Promise`\<`void`\>

Defined in: core/dist/object.d.ts:249

Validates object state before saving
Override in subclasses to add custom validation logic

#### Returns

`Promise`\<`void`\>

#### Inherited from

`SmrtObject.validateBeforeSave`

***

### validateValue()

> **validateValue**(`value`): `Promise`\<`boolean`\>

Defined in: [profiles/src/models/ProfileMetafield.ts:84](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/profiles/src/models/ProfileMetafield.ts#L84)

Validate a value against this metafield's validation schema

#### Parameters

##### value

`any`

The value to validate

#### Returns

`Promise`\<`boolean`\>

True if valid, throws ValidationError if invalid

***

### getBySlug()

> `static` **getBySlug**(`_slug`): `Promise`\<`ProfileMetafield` \| `null`\>

Defined in: [profiles/src/models/ProfileMetafield.ts:53](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/profiles/src/models/ProfileMetafield.ts#L53)

Convenience method for slug-based lookup

#### Parameters

##### \_slug

`string`

#### Returns

`Promise`\<`ProfileMetafield` \| `null`\>

ProfileMetafield instance or null if not found

***

### getValidator()

> `static` **getValidator**(`name`): [`ValidatorFunction`](../type-aliases/ValidatorFunction.md) \| `undefined`

Defined in: [profiles/src/models/ProfileMetafield.ts:74](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/profiles/src/models/ProfileMetafield.ts#L74)

Get a registered custom validator

#### Parameters

##### name

`string`

Name of the validator

#### Returns

[`ValidatorFunction`](../type-aliases/ValidatorFunction.md) \| `undefined`

The validator function or undefined

***

### registerValidator()

> `static` **registerValidator**(`name`, `validator`): `void`

Defined in: [profiles/src/models/ProfileMetafield.ts:64](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/profiles/src/models/ProfileMetafield.ts#L64)

Register a custom validator function

#### Parameters

##### name

`string`

Name of the validator (used in validation.custom field)

##### validator

[`ValidatorFunction`](../type-aliases/ValidatorFunction.md)

The validator function

#### Returns

`void`
