# Class: Mirror

Defined in: [content/src/content-types.ts:43](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/content/src/content-types.ts#L43)

Mirror content type

Represents mirrored/cached content from external sources.

## Extends

- [`Content`](Content.md)

## Constructors

### Constructor

> **new Mirror**(`options`): `Mirror`

Defined in: [content/src/content-types.ts:44](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/content/src/content-types.ts#L44)

#### Parameters

##### options

[`ContentOptions`](../interfaces/ContentOptions.md) = `{}`

#### Returns

`Mirror`

#### Overrides

[`Content`](Content.md).[`constructor`](Content.md#constructor)

## Properties

### \_ai

> `protected` **\_ai**: `AIClient`

Defined in: core/dist/class.d.ts:86

AI client instance for interacting with AI models

#### Inherited from

[`Content`](Content.md).[`_ai`](Content.md#_ai)

***

### \_className

> `protected` **\_className**: `string`

Defined in: core/dist/class.d.ts:98

Class name used for identification

#### Inherited from

[`Content`](Content.md).[`_className`](Content.md#_classname)

***

### \_context

> `protected` **\_context**: `string` \| `null` \| `undefined`

Defined in: core/dist/object.d.ts:79

Optional context to scope the slug

#### Inherited from

[`Content`](Content.md).[`_context`](Content.md#_context)

***

### \_db

> `protected` **\_db**: `DatabaseInterface`

Defined in: core/dist/class.d.ts:94

Database interface for data persistence

#### Inherited from

[`Content`](Content.md).[`_db`](Content.md#_db)

***

### \_fs

> `protected` **\_fs**: `FilesystemAdapter`

Defined in: core/dist/class.d.ts:90

Filesystem adapter for file operations

#### Inherited from

[`Content`](Content.md).[`_fs`](Content.md#_fs)

***

### \_id

> `protected` **\_id**: `string` \| `null` \| `undefined`

Defined in: core/dist/object.d.ts:71

Unique identifier for the object

#### Inherited from

[`Content`](Content.md).[`_id`](Content.md#_id)

***

### \_signalBus?

> `protected` `optional` **\_signalBus**: `SignalBus`

Defined in: core/dist/class.d.ts:102

Signal bus for method execution tracking

#### Inherited from

[`Content`](Content.md).[`_signalBus`](Content.md#_signalbus)

***

### \_slug

> `protected` **\_slug**: `string` \| `null` \| `undefined`

Defined in: core/dist/object.d.ts:75

URL-friendly identifier

#### Inherited from

[`Content`](Content.md).[`_slug`](Content.md#_slug)

***

### \_tableName

> **\_tableName**: `string`

Defined in: core/dist/object.d.ts:52

Database table name for this object

#### Inherited from

[`Content`](Content.md).[`_tableName`](Content.md#_tablename)

***

### author

> **author**: `string` \| `null` = `null`

Defined in: [content/src/content.ts:135](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/content/src/content.ts#L135)

Author of the content

#### Inherited from

[`Content`](Content.md).[`author`](Content.md#author)

***

### body

> **body**: `string` = `''`

Defined in: [content/src/content.ts:155](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/content/src/content.ts#L155)

Main content body text

#### Inherited from

[`Content`](Content.md).[`body`](Content.md#body)

***

### created\_at

> **created\_at**: `Date` \| `null` \| `undefined`

Defined in: core/dist/object.d.ts:83

Creation timestamp

#### Inherited from

[`Content`](Content.md).[`created_at`](Content.md#created_at)

***

### description

> **description**: `string` \| `null` = `null`

Defined in: [content/src/content.ts:150](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/content/src/content.ts#L150)

Short description or summary

#### Inherited from

[`Content`](Content.md).[`description`](Content.md#description)

***

### fileKey

> **fileKey**: `string` \| `null` = `null`

Defined in: [content/src/content.ts:130](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/content/src/content.ts#L130)

Reference to file storage key

#### Inherited from

[`Content`](Content.md).[`fileKey`](Content.md#filekey)

***

### language

> **language**: `string` \| `null` = `null`

Defined in: [content/src/content.ts:180](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/content/src/content.ts#L180)

Content language

#### Inherited from

[`Content`](Content.md).[`language`](Content.md#language)

***

### metadata

> **metadata**: `Record`\<`string`, `any`\> = `{}`

Defined in: [content/src/content.ts:200](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/content/src/content.ts#L200)

Additional JSON metadata for flexible schema extension

#### Inherited from

[`Content`](Content.md).[`metadata`](Content.md#metadata)

***

### name

> **name**: `Field`

Defined in: [content/src/content.ts:140](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/content/src/content.ts#L140)

Human-readable name for SMRT framework compatibility

#### Inherited from

[`Content`](Content.md).[`name`](Content.md#name)

***

### options

> **options**: `SmrtObjectOptions`

Defined in: core/dist/object.d.ts:67

Override options with SmrtObjectOptions type for proper type narrowing.
Initialized by parent constructor via super() call.

#### Inherited from

[`Content`](Content.md).[`options`](Content.md#options)

***

### original\_url

> **original\_url**: `string` \| `null` = `null`

Defined in: [content/src/content.ts:175](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/content/src/content.ts#L175)

Original URL of the content

#### Inherited from

[`Content`](Content.md).[`original_url`](Content.md#original_url)

***

### publish\_date

> **publish\_date**: `Date` \| `null` = `null`

Defined in: [content/src/content.ts:160](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/content/src/content.ts#L160)

Date when content was published

#### Inherited from

[`Content`](Content.md).[`publish_date`](Content.md#publish_date)

***

### references

> `protected` **references**: [`Content`](Content.md)[] = `[]`

Defined in: [content/src/content.ts:113](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/content/src/content.ts#L113)

Array of referenced content objects

#### Inherited from

[`Content`](Content.md).[`references`](Content.md#references)

***

### source

> **source**: `string` \| `null` = `null`

Defined in: [content/src/content.ts:170](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/content/src/content.ts#L170)

Original source identifier

#### Inherited from

[`Content`](Content.md).[`source`](Content.md#source)

***

### state

> **state**: `"deprecated"` \| `"active"` \| `"highlighted"` = `'active'`

Defined in: [content/src/content.ts:195](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/content/src/content.ts#L195)

Content state flag

#### Inherited from

[`Content`](Content.md).[`state`](Content.md#state)

***

### status

> **status**: `"published"` \| `"draft"` \| `"archived"` \| `"deleted"` = `'draft'`

Defined in: [content/src/content.ts:190](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/content/src/content.ts#L190)

Publication status

#### Inherited from

[`Content`](Content.md).[`status`](Content.md#status)

***

### tags

> **tags**: `string`[] = `[]`

Defined in: [content/src/content.ts:185](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/content/src/content.ts#L185)

Content tags

#### Inherited from

[`Content`](Content.md).[`tags`](Content.md#tags)

***

### title

> **title**: `string` = `''`

Defined in: [content/src/content.ts:145](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/content/src/content.ts#L145)

Content title

#### Inherited from

[`Content`](Content.md).[`title`](Content.md#title)

***

### type

> **type**: `string` \| `null` = `null`

Defined in: [content/src/content.ts:118](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/content/src/content.ts#L118)

Content type classification

#### Inherited from

[`Content`](Content.md).[`type`](Content.md#type)

***

### updated\_at

> **updated\_at**: `Date` \| `null` \| `undefined`

Defined in: core/dist/object.d.ts:87

Last update timestamp

#### Inherited from

[`Content`](Content.md).[`updated_at`](Content.md#updated_at)

***

### url

> **url**: `string` \| `null` = `null`

Defined in: [content/src/content.ts:165](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/content/src/content.ts#L165)

URL source of the content

#### Inherited from

[`Content`](Content.md).[`url`](Content.md#url)

***

### variant

> **variant**: `string` \| `null` = `null`

Defined in: [content/src/content.ts:125](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/content/src/content.ts#L125)

Content variant for namespaced classification within types
Format: generator:domain:specific-type
Example: "praeco:meeting:upcoming"

#### Inherited from

[`Content`](Content.md).[`variant`](Content.md#variant)

## Accessors

### ai

#### Get Signature

> **get** **ai**(): `AIClient`

Defined in: core/dist/class.d.ts:211

Gets the AI client instance

##### Returns

`AIClient`

#### Inherited from

[`Content`](Content.md).[`ai`](Content.md#ai)

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

[`Content`](Content.md).[`context`](Content.md#context)

***

### db

#### Get Signature

> **get** **db**(): `DatabaseInterface`

Defined in: core/dist/class.d.ts:207

Gets the database interface instance

##### Returns

`DatabaseInterface`

#### Inherited from

[`Content`](Content.md).[`db`](Content.md#db)

***

### fs

#### Get Signature

> **get** **fs**(): `FilesystemAdapter`

Defined in: core/dist/class.d.ts:203

Gets the filesystem adapter instance

##### Returns

`FilesystemAdapter`

#### Inherited from

[`Content`](Content.md).[`fs`](Content.md#fs)

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

[`Content`](Content.md).[`id`](Content.md#id)

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

[`Content`](Content.md).[`signalBus`](Content.md#signalbus)

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

[`Content`](Content.md).[`slug`](Content.md#slug)

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

[`Content`](Content.md).[`systemDb`](Content.md#systemdb)

***

### tableName

#### Get Signature

> **get** **tableName**(): `string`

Defined in: core/dist/object.d.ts:191

Gets the database table name for this object

##### Returns

`string`

#### Inherited from

[`Content`](Content.md).[`tableName`](Content.md#tablename)

## Methods

### addReference()

> **addReference**(`content`): `Promise`\<`void`\>

Defined in: [content/src/content.ts:247](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/content/src/content.ts#L247)

Adds a reference to another content object

#### Parameters

##### content

Content object or URL to reference

`string` | [`Content`](Content.md)

#### Returns

`Promise`\<`void`\>

Promise that resolves when the reference is added

#### Inherited from

[`Content`](Content.md).[`addReference`](Content.md#addreference)

***

### allDescriptors()

> **allDescriptors**(): `object` & `object`

Defined in: core/dist/object.d.ts:183

Gets all property descriptors from this object's prototype

#### Returns

`object` & `object`

Object containing all property descriptors

#### Inherited from

[`Content`](Content.md).[`allDescriptors`](Content.md#alldescriptors)

***

### delete()

> **delete**(): `Promise`\<`void`\>

Defined in: core/dist/object.d.ts:331

Delete this object from the database

#### Returns

`Promise`\<`void`\>

Promise that resolves when deletion is complete

#### Inherited from

[`Content`](Content.md).[`delete`](Content.md#delete)

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

[`Content`](Content.md).[`describe`](Content.md#describe)

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

[`Content`](Content.md).[`destroy`](Content.md#destroy)

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

[`Content`](Content.md).[`do`](Content.md#do)

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

[`Content`](Content.md).[`ensureDbSetup`](Content.md#ensuredbsetup)

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

[`Content`](Content.md).[`executeToolCall`](Content.md#executetoolcall)

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

[`Content`](Content.md).[`extractConstraintField`](Content.md#extractconstraintfield)

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

[`Content`](Content.md).[`forget`](Content.md#forget)

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

[`Content`](Content.md).[`forgetScope`](Content.md#forgetscope)

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

[`Content`](Content.md).[`getAvailableTools`](Content.md#getavailabletools)

***

### getFields()

> **getFields**(): `Promise`\<`Record`\<`string`, `any`\>\>

Defined in: core/dist/object.d.ts:197

Gets field definitions and current values for this object

#### Returns

`Promise`\<`Record`\<`string`, `any`\>\>

Object containing field definitions with current values

#### Inherited from

[`Content`](Content.md).[`getFields`](Content.md#getfields)

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

[`Content`](Content.md).[`getFieldValue`](Content.md#getfieldvalue)

***

### getId()

> **getId**(): `Promise`\<`string`\>

Defined in: core/dist/object.d.ts:218

Gets or generates a unique ID for this object

#### Returns

`Promise`\<`string`\>

Promise resolving to the object's ID

#### Inherited from

[`Content`](Content.md).[`getId`](Content.md#getid)

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

[`Content`](Content.md).[`getPropertyValue`](Content.md#getpropertyvalue)

***

### getReferences()

> **getReferences**(): `Promise`\<[`Content`](Content.md)[]\>

Defined in: [content/src/content.ts:262](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/content/src/content.ts#L262)

Gets all referenced content objects

#### Returns

`Promise`\<[`Content`](Content.md)[]\>

Promise resolving to an array of referenced Content objects

#### Inherited from

[`Content`](Content.md).[`getReferences`](Content.md#getreferences)

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

[`Content`](Content.md).[`getRelated`](Content.md#getrelated)

***

### getSavedId()

> **getSavedId**(): `Promise`\<`any`\>

Defined in: core/dist/object.d.ts:232

Gets the ID of this object if it's already saved in the database

#### Returns

`Promise`\<`any`\>

Promise resolving to the saved ID or null if not saved

#### Inherited from

[`Content`](Content.md).[`getSavedId`](Content.md#getsavedid)

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

[`Content`](Content.md).[`getSlug`](Content.md#getslug)

***

### initialize()

> **initialize**(): `Promise`\<`Mirror`\>

Defined in: [content/src/content.ts:229](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/content/src/content.ts#L229)

Initializes this content object

#### Returns

`Promise`\<`Mirror`\>

Promise that resolves to this instance

#### Inherited from

[`Content`](Content.md).[`initialize`](Content.md#initialize)

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

[`Content`](Content.md).[`is`](Content.md#is)

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

[`Content`](Content.md).[`isRelatedLoaded`](Content.md#isrelatedloaded)

***

### isSaved()

> **isSaved**(): `Promise`\<`boolean`\>

Defined in: core/dist/object.d.ts:238

Checks if this object is already saved in the database

#### Returns

`Promise`\<`boolean`\>

Promise resolving to true if saved, false otherwise

#### Inherited from

[`Content`](Content.md).[`isSaved`](Content.md#issaved)

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

[`Content`](Content.md).[`loadDataFromDb`](Content.md#loaddatafromdb)

***

### loadFromId()

> **loadFromId**(): `Promise`\<`void`\>

Defined in: core/dist/object.d.ts:274

Loads this object's data from the database using its ID

#### Returns

`Promise`\<`void`\>

Promise that resolves when loading is complete

#### Inherited from

[`Content`](Content.md).[`loadFromId`](Content.md#loadfromid)

***

### loadFromSlug()

> **loadFromSlug**(): `Promise`\<`void`\>

Defined in: core/dist/object.d.ts:280

Loads this object's data from the database using its slug and context

#### Returns

`Promise`\<`void`\>

Promise that resolves when loading is complete

#### Inherited from

[`Content`](Content.md).[`loadFromSlug`](Content.md#loadfromslug)

***

### loadReferences()

> **loadReferences**(): `Promise`\<`void`\>

Defined in: [content/src/content.ts:239](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/content/src/content.ts#L239)

Loads referenced content objects

#### Returns

`Promise`\<`void`\>

Promise that resolves when references are loaded

#### Inherited from

[`Content`](Content.md).[`loadReferences`](Content.md#loadreferences)

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

[`Content`](Content.md).[`loadRelated`](Content.md#loadrelated)

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

[`Content`](Content.md).[`loadRelatedMany`](Content.md#loadrelatedmany)

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

[`Content`](Content.md).[`recall`](Content.md#recall)

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

[`Content`](Content.md).[`recallAll`](Content.md#recallall)

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

[`Content`](Content.md).[`remember`](Content.md#remember)

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

[`Content`](Content.md).[`requiresDatabase`](Content.md#requiresdatabase)

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

[`Content`](Content.md).[`runHook`](Content.md#runhook)

***

### save()

> **save**(): `Promise`\<`Mirror`\>

Defined in: core/dist/object.d.ts:244

Saves this object to the database

#### Returns

`Promise`\<`Mirror`\>

Promise resolving to this object

#### Inherited from

[`Content`](Content.md).[`save`](Content.md#save)

***

### toJSON()

> **toJSON**(): `object`

Defined in: [content/src/content.ts:271](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/content/src/content.ts#L271)

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

#### Inherited from

[`Content`](Content.md).[`toJSON`](Content.md#tojson)

***

### validateBeforeSave()

> `protected` **validateBeforeSave**(): `Promise`\<`void`\>

Defined in: core/dist/object.d.ts:249

Validates object state before saving
Override in subclasses to add custom validation logic

#### Returns

`Promise`\<`void`\>

#### Inherited from

[`Content`](Content.md).[`validateBeforeSave`](Content.md#validatebeforesave)
