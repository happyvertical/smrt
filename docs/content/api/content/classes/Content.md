# Class: Content

Defined in: content/src/content.ts:107

Structured content object with metadata and body text

Content represents any text-based content with metadata such as
title, author, description, and publishing information. It supports
referencing related content objects.

## Extends

- `SmrtObject`

## Constructors

### Constructor

> **new Content**(`options`): `Content`

Defined in: content/src/content.ts:198

Creates a new Content instance

#### Parameters

##### options

[`ContentOptions`](../interfaces/ContentOptions.md) = `{}`

#### Returns

`Content`

#### Overrides

`SmrtObject.constructor`

## Properties

### \_ai

> `protected` **\_ai**: `AIClient`

Defined in: core/dist/class.d.ts:75

AI client instance for interacting with AI models

#### Inherited from

`SmrtObject._ai`

***

### \_className

> `protected` **\_className**: `string`

Defined in: core/dist/class.d.ts:87

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

Defined in: core/dist/class.d.ts:83

Database interface for data persistence

#### Inherited from

`SmrtObject._db`

***

### \_fs

> `protected` **\_fs**: `FilesystemAdapter`

Defined in: core/dist/class.d.ts:79

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

Defined in: core/dist/class.d.ts:91

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

Defined in: core/dist/object.d.ts:57

Database table name for this object

#### Inherited from

`SmrtObject._tableName`

***

### author

> **author**: `string` \| `null` = `null`

Defined in: content/src/content.ts:133

Author of the content

***

### body

> **body**: `string` = `''`

Defined in: content/src/content.ts:148

Main content body text

***

### created\_at

> **created\_at**: `Date` \| `null` \| `undefined`

Defined in: core/dist/object.d.ts:88

Creation timestamp

#### Inherited from

`SmrtObject.created_at`

***

### description

> **description**: `string` \| `null` = `null`

Defined in: content/src/content.ts:143

Short description or summary

***

### fileKey

> **fileKey**: `string` \| `null` = `null`

Defined in: content/src/content.ts:128

Reference to file storage key

***

### language

> **language**: `string` \| `null` = `null`

Defined in: content/src/content.ts:173

Content language

***

### metadata

> **metadata**: `Record`\<`string`, `any`\> = `{}`

Defined in: content/src/content.ts:193

Additional JSON metadata for flexible schema extension

***

### name?

> `optional` **name**: `string` \| `Field` \| `null`

Defined in: core/dist/object.d.ts:84

Human-readable name, primarily for display purposes
Can be a string value or a Field instance (for Field-based schema definition)

#### Inherited from

`SmrtObject.name`

***

### options

> `protected` **options**: `SmrtObjectOptions`

Defined in: core/dist/object.d.ts:67

Override options with SmrtObjectOptions type for proper type narrowing.
Initialized by parent constructor via super() call.

#### Inherited from

`SmrtObject.options`

***

### original\_url

> **original\_url**: `string` \| `null` = `null`

Defined in: content/src/content.ts:168

Original URL of the content

***

### publish\_date

> **publish\_date**: `Date` \| `null` = `null`

Defined in: content/src/content.ts:153

Date when content was published

***

### references

> `protected` **references**: `Content`[] = `[]`

Defined in: content/src/content.ts:111

Array of referenced content objects

***

### source

> **source**: `string` \| `null` = `null`

Defined in: content/src/content.ts:163

Original source identifier

***

### state

> **state**: `"deprecated"` \| `"active"` \| `"highlighted"` = `'active'`

Defined in: content/src/content.ts:188

Content state flag

***

### status

> **status**: `"published"` \| `"draft"` \| `"archived"` \| `"deleted"` = `'draft'`

Defined in: content/src/content.ts:183

Publication status

***

### tags

> **tags**: `string`[] = `[]`

Defined in: content/src/content.ts:178

Content tags

***

### title

> **title**: `string` = `''`

Defined in: content/src/content.ts:138

Content title

***

### type

> **type**: `string` \| `null` = `null`

Defined in: content/src/content.ts:116

Content type classification

***

### updated\_at

> **updated\_at**: `Date` \| `null` \| `undefined`

Defined in: core/dist/object.d.ts:92

Last update timestamp

#### Inherited from

`SmrtObject.updated_at`

***

### url

> **url**: `string` \| `null` = `null`

Defined in: content/src/content.ts:158

URL source of the content

***

### variant

> **variant**: `string` \| `null` = `null`

Defined in: content/src/content.ts:123

Content variant for namespaced classification within types
Format: generator:domain:specific-type
Example: "praeco:meeting:upcoming"

## Accessors

### ai

#### Get Signature

> **get** **ai**(): `AIClient`

Defined in: core/dist/class.d.ts:185

Gets the AI client instance

##### Returns

`AIClient`

#### Inherited from

`SmrtObject.ai`

***

### context

#### Get Signature

> **get** **context**(): `string`

Defined in: core/dist/object.d.ts:130

Gets the context that scopes this object's slug

##### Returns

`string`

#### Set Signature

> **set** **context**(`value`): `void`

Defined in: core/dist/object.d.ts:137

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

Defined in: core/dist/class.d.ts:181

Gets the database interface instance

##### Returns

`DatabaseInterface`

#### Inherited from

`SmrtObject.db`

***

### fs

#### Get Signature

> **get** **fs**(): `FilesystemAdapter`

Defined in: core/dist/class.d.ts:177

Gets the filesystem adapter instance

##### Returns

`FilesystemAdapter`

#### Inherited from

`SmrtObject.fs`

***

### id

#### Get Signature

> **get** **id**(): `string` \| `null` \| `undefined`

Defined in: core/dist/object.d.ts:108

Gets the unique identifier for this object

##### Returns

`string` \| `null` \| `undefined`

#### Set Signature

> **set** **id**(`value`): `void`

Defined in: core/dist/object.d.ts:115

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

Defined in: core/dist/class.d.ts:191

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

Defined in: core/dist/object.d.ts:119

Gets the URL-friendly slug for this object

##### Returns

`string` \| `null` \| `undefined`

#### Set Signature

> **set** **slug**(`value`): `void`

Defined in: core/dist/object.d.ts:126

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

Defined in: core/dist/class.d.ts:142

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

Defined in: core/dist/object.d.ts:163

Gets the database table name for this object

##### Returns

`string`

#### Inherited from

`SmrtObject.tableName`

## Methods

### addReference()

> **addReference**(`content`): `Promise`\<`void`\>

Defined in: content/src/content.ts:244

Adds a reference to another content object

#### Parameters

##### content

Content object or URL to reference

`string` | `Content`

#### Returns

`Promise`\<`void`\>

Promise that resolves when the reference is added

***

### allDescriptors()

> **allDescriptors**(): `object` & `object`

Defined in: core/dist/object.d.ts:155

Gets all property descriptors from this object's prototype

#### Returns

`object` & `object`

Object containing all property descriptors

#### Inherited from

`SmrtObject.allDescriptors`

***

### delete()

> **delete**(): `Promise`\<`void`\>

Defined in: core/dist/object.d.ts:271

Delete this object from the database

#### Returns

`Promise`\<`void`\>

Promise that resolves when deletion is complete

#### Inherited from

`SmrtObject.delete`

***

### destroy()

> **destroy**(): `void`

Defined in: core/dist/class.d.ts:207

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

Defined in: core/dist/object.d.ts:258

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

### executeToolCall()

> **executeToolCall**(`toolCall`): `Promise`\<`ToolCallResult`\>

Defined in: core/dist/object.d.ts:374

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

Defined in: core/dist/object.d.ts:229

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

Defined in: core/dist/object.d.ts:482

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

Defined in: core/dist/object.d.ts:504

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

Defined in: core/dist/object.d.ts:350

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

> **getFields**(): `Record`\<`string`, `any`\>

Defined in: core/dist/object.d.ts:169

Gets field definitions and current values for this object

#### Returns

`Record`\<`string`, `any`\>

Object containing field definitions with current values

#### Inherited from

`SmrtObject.getFields`

***

### getFieldValue()

> `protected` **getFieldValue**(`fieldName`): `any`

Defined in: core/dist/object.d.ts:214

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

Defined in: core/dist/object.d.ts:181

Gets or generates a unique ID for this object

#### Returns

`Promise`\<`string`\>

Promise resolving to the object's ID

#### Inherited from

`SmrtObject.getId`

***

### getPropertyValue()

> `protected` **getPropertyValue**(`key`): `any`

Defined in: core/dist/object.d.ts:225

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

### getReferences()

> **getReferences**(): `Promise`\<`Content`[]\>

Defined in: content/src/content.ts:259

Gets all referenced content objects

#### Returns

`Promise`\<`Content`[]\>

Promise resolving to an array of referenced Content objects

***

### getRelated()

> **getRelated**(`fieldName`): `Promise`\<`any`\>

Defined in: core/dist/object.d.ts:336

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

Defined in: core/dist/object.d.ts:193

Gets the ID of this object if it's already saved in the database

#### Returns

`Promise`\<`any`\>

Promise resolving to the saved ID or null if not saved

#### Inherited from

`SmrtObject.getSavedId`

***

### getSlug()

> **getSlug**(): `Promise`\<`string` \| `null` \| `undefined`\>

Defined in: core/dist/object.d.ts:187

Gets or generates a slug for this object based on its name

#### Returns

`Promise`\<`string` \| `null` \| `undefined`\>

Promise resolving to the object's slug

#### Inherited from

`SmrtObject.getSlug`

***

### initialize()

> **initialize**(): `Promise`\<`Content`\>

Defined in: content/src/content.ts:222

Initializes this content object

#### Returns

`Promise`\<`Content`\>

Promise that resolves to this instance

#### Overrides

`SmrtObject.initialize`

***

### is()

> **is**(`criteria`, `options?`): `Promise`\<`any`\>

Defined in: core/dist/object.d.ts:250

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

Defined in: core/dist/object.d.ts:284

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

Defined in: core/dist/object.d.ts:199

Checks if this object is already saved in the database

#### Returns

`Promise`\<`boolean`\>

Promise resolving to true if saved, false otherwise

#### Inherited from

`SmrtObject.isSaved`

***

### loadDataFromDb()

> **loadDataFromDb**(`data`): `void`

Defined in: core/dist/object.d.ts:149

Loads data from a database row into this object's properties

#### Parameters

##### data

`any`

Database row data

#### Returns

`void`

#### Inherited from

`SmrtObject.loadDataFromDb`

***

### loadFromId()

> **loadFromId**(): `Promise`\<`void`\>

Defined in: core/dist/object.d.ts:235

Loads this object's data from the database using its ID

#### Returns

`Promise`\<`void`\>

Promise that resolves when loading is complete

#### Inherited from

`SmrtObject.loadFromId`

***

### loadFromSlug()

> **loadFromSlug**(): `Promise`\<`void`\>

Defined in: core/dist/object.d.ts:241

Loads this object's data from the database using its slug and context

#### Returns

`Promise`\<`void`\>

Promise that resolves when loading is complete

#### Inherited from

`SmrtObject.loadFromSlug`

***

### loadReferences()

> **loadReferences**(): `Promise`\<`void`\>

Defined in: content/src/content.ts:236

Loads referenced content objects

#### Returns

`Promise`\<`void`\>

Promise that resolves when references are loaded

***

### loadRelated()

> **loadRelated**(`fieldName`): `Promise`\<`any`\>

Defined in: core/dist/object.d.ts:301

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

Defined in: core/dist/object.d.ts:318

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

Defined in: core/dist/object.d.ts:433

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

Defined in: core/dist/object.d.ts:460

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

Defined in: core/dist/object.d.ts:404

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

### runHook()

> `protected` **runHook**(`hookName`): `Promise`\<`void`\>

Defined in: core/dist/object.d.ts:265

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

> **save**(): `Promise`\<`Content`\>

Defined in: core/dist/object.d.ts:205

Saves this object to the database

#### Returns

`Promise`\<`Content`\>

Promise resolving to this object

#### Inherited from

`SmrtObject.save`

***

### toJSON()

> **toJSON**(): `object`

Defined in: content/src/content.ts:268

Converts this content object to a plain JSON object

#### Returns

`object`

JSON representation of this content

##### author

> **author**: `string`

##### body

> **body**: `string`

##### context

> **context**: `string`

##### description

> **description**: `string`

##### fileKey

> **fileKey**: `string`

##### id

> **id**: `string`

##### publish\_date

> **publish\_date**: `string` \| `Date`

##### slug

> **slug**: `string`

##### source

> **source**: `string`

##### state

> **state**: `"deprecated"` \| `"active"` \| `"highlighted"`

##### status

> **status**: `"published"` \| `"draft"` \| `"archived"` \| `"deleted"`

##### title

> **title**: `string`

##### type

> **type**: `string` \| `null`

##### url

> **url**: `string`

##### variant

> **variant**: `string`

#### Overrides

`SmrtObject.toJSON`

***

### validateBeforeSave()

> `protected` **validateBeforeSave**(): `Promise`\<`void`\>

Defined in: core/dist/object.d.ts:210

Validates object state before saving
Override in subclasses to add custom validation logic

#### Returns

`Promise`\<`void`\>

#### Inherited from

`SmrtObject.validateBeforeSave`
