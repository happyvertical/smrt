# Class: Pleb

Defined in: [smrt/packages/core/src/pleb.ts:28](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/pleb.ts#L28)

Basic implementation class extending SmrtObject

Pleb provides a simple SmrtObject implementation for quick prototyping
and testing without requiring custom field definitions.

 Pleb

## Example

```typescript
const pleb = await Pleb.create({
  name: 'Test Object',
  db: { url: 'sqlite://test.db' }
});
```

## Extends

- [`SmrtObject`](SmrtObject.md)

## Constructors

### Constructor

> **new Pleb**(`options`): `Pleb`

Defined in: [smrt/packages/core/src/pleb.ts:34](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/pleb.ts#L34)

Creates a new Pleb instance

#### Parameters

##### options

[`PlebOptions`](../interfaces/PlebOptions.md) = `{}`

Configuration options for the Pleb object

#### Returns

`Pleb`

#### Overrides

[`SmrtObject`](SmrtObject.md).[`constructor`](SmrtObject.md#constructor)

## Properties

### \_ai

> `protected` **\_ai**: `AIClient`

Defined in: [smrt/packages/core/src/class.ts:97](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/class.ts#L97)

AI client instance for interacting with AI models

#### Inherited from

[`SmrtObject`](SmrtObject.md).[`_ai`](SmrtObject.md#_ai)

***

### \_className

> `protected` **\_className**: `string`

Defined in: [smrt/packages/core/src/class.ts:112](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/class.ts#L112)

Class name used for identification

#### Inherited from

[`SmrtObject`](SmrtObject.md).[`_className`](SmrtObject.md#_classname)

***

### \_context

> `protected` **\_context**: `string` \| `null` \| `undefined`

Defined in: [smrt/packages/core/src/object.ts:114](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L114)

Optional context to scope the slug

#### Inherited from

[`SmrtObject`](SmrtObject.md).[`_context`](SmrtObject.md#_context)

***

### \_db

> `protected` **\_db**: `DatabaseInterface`

Defined in: [smrt/packages/core/src/class.ts:107](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/class.ts#L107)

Database interface for data persistence

#### Inherited from

[`SmrtObject`](SmrtObject.md).[`_db`](SmrtObject.md#_db)

***

### \_fs

> `protected` **\_fs**: `FilesystemAdapter`

Defined in: [smrt/packages/core/src/class.ts:102](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/class.ts#L102)

Filesystem adapter for file operations

#### Inherited from

[`SmrtObject`](SmrtObject.md).[`_fs`](SmrtObject.md#_fs)

***

### \_id

> `protected` **\_id**: `string` \| `null` \| `undefined`

Defined in: [smrt/packages/core/src/object.ts:104](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L104)

Unique identifier for the object

#### Inherited from

[`SmrtObject`](SmrtObject.md).[`_id`](SmrtObject.md#_id)

***

### \_signalBus?

> `protected` `optional` **\_signalBus**: [`SignalBus`](SignalBus.md)

Defined in: [smrt/packages/core/src/class.ts:117](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/class.ts#L117)

Signal bus for method execution tracking

#### Inherited from

[`SmrtObject`](SmrtObject.md).[`_signalBus`](SmrtObject.md#_signalbus)

***

### \_slug

> `protected` **\_slug**: `string` \| `null` \| `undefined`

Defined in: [smrt/packages/core/src/object.ts:109](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L109)

URL-friendly identifier

#### Inherited from

[`SmrtObject`](SmrtObject.md).[`_slug`](SmrtObject.md#_slug)

***

### \_tableName

> **\_tableName**: `string`

Defined in: [smrt/packages/core/src/object.ts:87](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L87)

Database table name for this object

#### Inherited from

[`SmrtObject`](SmrtObject.md).[`_tableName`](SmrtObject.md#_tablename)

***

### created\_at

> **created\_at**: `Date` \| `null` \| `undefined` = `null`

Defined in: [smrt/packages/core/src/object.ts:125](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L125)

Creation timestamp

#### Inherited from

[`SmrtObject`](SmrtObject.md).[`created_at`](SmrtObject.md#created_at)

***

### name?

> `optional` **name**: `string` \| [`Field`](Field.md) \| `null` = `null`

Defined in: [smrt/packages/core/src/object.ts:120](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L120)

Human-readable name, primarily for display purposes
Can be a string value or a Field instance (for Field-based schema definition)

#### Inherited from

[`SmrtObject`](SmrtObject.md).[`name`](SmrtObject.md#name)

***

### options

> `protected` **options**: [`SmrtObjectOptions`](../interfaces/SmrtObjectOptions.md)

Defined in: [smrt/packages/core/src/object.ts:99](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L99)

Override options with SmrtObjectOptions type for proper type narrowing.
Initialized by parent constructor via super() call.

#### Inherited from

[`SmrtObject`](SmrtObject.md).[`options`](SmrtObject.md#options)

***

### updated\_at

> **updated\_at**: `Date` \| `null` \| `undefined` = `null`

Defined in: [smrt/packages/core/src/object.ts:130](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L130)

Last update timestamp

#### Inherited from

[`SmrtObject`](SmrtObject.md).[`updated_at`](SmrtObject.md#updated_at)

## Accessors

### ai

#### Get Signature

> **get** **ai**(): `AIClient`

Defined in: [smrt/packages/core/src/class.ts:388](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/class.ts#L388)

Gets the AI client instance

##### Returns

`AIClient`

#### Inherited from

[`SmrtObject`](SmrtObject.md).[`ai`](SmrtObject.md#ai)

***

### context

#### Get Signature

> **get** **context**(): `string`

Defined in: [smrt/packages/core/src/object.ts:239](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L239)

Gets the context that scopes this object's slug

##### Returns

`string`

#### Set Signature

> **set** **context**(`value`): `void`

Defined in: [smrt/packages/core/src/object.ts:249](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L249)

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

[`SmrtObject`](SmrtObject.md).[`context`](SmrtObject.md#context)

***

### db

#### Get Signature

> **get** **db**(): `DatabaseInterface`

Defined in: [smrt/packages/core/src/class.ts:381](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/class.ts#L381)

Gets the database interface instance

##### Returns

`DatabaseInterface`

#### Inherited from

[`SmrtObject`](SmrtObject.md).[`db`](SmrtObject.md#db)

***

### fs

#### Get Signature

> **get** **fs**(): `FilesystemAdapter`

Defined in: [smrt/packages/core/src/class.ts:374](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/class.ts#L374)

Gets the filesystem adapter instance

##### Returns

`FilesystemAdapter`

#### Inherited from

[`SmrtObject`](SmrtObject.md).[`fs`](SmrtObject.md#fs)

***

### id

#### Get Signature

> **get** **id**(): `string` \| `null` \| `undefined`

Defined in: [smrt/packages/core/src/object.ts:198](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L198)

Gets the unique identifier for this object

##### Returns

`string` \| `null` \| `undefined`

#### Set Signature

> **set** **id**(`value`): `void`

Defined in: [smrt/packages/core/src/object.ts:208](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L208)

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

[`SmrtObject`](SmrtObject.md).[`id`](SmrtObject.md#id)

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

[`SmrtObject`](SmrtObject.md).[`signalBus`](SmrtObject.md#signalbus)

***

### slug

#### Get Signature

> **get** **slug**(): `string` \| `null` \| `undefined`

Defined in: [smrt/packages/core/src/object.ts:218](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L218)

Gets the URL-friendly slug for this object

##### Returns

`string` \| `null` \| `undefined`

#### Set Signature

> **set** **slug**(`value`): `void`

Defined in: [smrt/packages/core/src/object.ts:228](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L228)

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

[`SmrtObject`](SmrtObject.md).[`slug`](SmrtObject.md#slug)

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

[`SmrtObject`](SmrtObject.md).[`systemDb`](SmrtObject.md#systemdb)

***

### tableName

#### Get Signature

> **get** **tableName**(): `string`

Defined in: [smrt/packages/core/src/object.ts:314](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L314)

Gets the database table name for this object

##### Returns

`string`

#### Inherited from

[`SmrtObject`](SmrtObject.md).[`tableName`](SmrtObject.md#tablename)

## Methods

### allDescriptors()

> **allDescriptors**(): `object` & `object`

Defined in: [smrt/packages/core/src/object.ts:305](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L305)

Gets all property descriptors from this object's prototype

#### Returns

`object` & `object`

Object containing all property descriptors

#### Inherited from

[`SmrtObject`](SmrtObject.md).[`allDescriptors`](SmrtObject.md#alldescriptors)

***

### delete()

> **delete**(): `Promise`\<`void`\>

Defined in: [smrt/packages/core/src/object.ts:765](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L765)

Delete this object from the database

#### Returns

`Promise`\<`void`\>

Promise that resolves when deletion is complete

#### Inherited from

[`SmrtObject`](SmrtObject.md).[`delete`](SmrtObject.md#delete)

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

[`SmrtObject`](SmrtObject.md).[`destroy`](SmrtObject.md#destroy)

***

### do()

> **do**(`instructions`, `options`): `Promise`\<`string`\>

Defined in: [smrt/packages/core/src/object.ts:716](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L716)

Performs actions on this object based on instructions using AI

#### Parameters

##### instructions

`string`

Instructions for the AI to follow

##### options

`any` = `{}`

AI message options

#### Returns

`Promise`\<`string`\>

Promise resolving to the AI response

#### Inherited from

[`SmrtObject`](SmrtObject.md).[`do`](SmrtObject.md#do)

***

### executeToolCall()

> **executeToolCall**(`toolCall`): `Promise`\<[`ToolCallResult`](../interfaces/ToolCallResult.md)\>

Defined in: [smrt/packages/core/src/object.ts:1024](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L1024)

Execute a tool call from AI on this object instance

Validates the tool call against allowed methods and executes it with
proper error handling and timing.

#### Parameters

##### toolCall

[`ToolCall`](../interfaces/ToolCall.md)

Tool call from AI response

#### Returns

`Promise`\<[`ToolCallResult`](../interfaces/ToolCallResult.md)\>

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

[`SmrtObject`](SmrtObject.md).[`executeToolCall`](SmrtObject.md#executetoolcall)

***

### extractConstraintField()

> `protected` **extractConstraintField**(`errorMessage`): `string`

Defined in: [smrt/packages/core/src/object.ts:599](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L599)

Extracts field name from database constraint error messages

#### Parameters

##### errorMessage

`string`

#### Returns

`string`

#### Inherited from

[`SmrtObject`](SmrtObject.md).[`extractConstraintField`](SmrtObject.md#extractconstraintfield)

***

### forget()

> **forget**(`options`): `Promise`\<`void`\>

Defined in: [smrt/packages/core/src/object.ts:1256](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L1256)

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

[`SmrtObject`](SmrtObject.md).[`forget`](SmrtObject.md#forget)

***

### forgetScope()

> **forgetScope**(`options`): `Promise`\<`number`\>

Defined in: [smrt/packages/core/src/object.ts:1289](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L1289)

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

[`SmrtObject`](SmrtObject.md).[`forgetScope`](SmrtObject.md#forgetscope)

***

### getAvailableTools()

> **getAvailableTools**(): `AITool`[]

Defined in: [smrt/packages/core/src/object.ts:996](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L996)

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

[`SmrtObject`](SmrtObject.md).[`getAvailableTools`](SmrtObject.md#getavailabletools)

***

### getFields()

> **getFields**(): `Record`\<`string`, `any`\>

Defined in: [smrt/packages/core/src/object.ts:326](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L326)

Gets field definitions and current values for this object

#### Returns

`Record`\<`string`, `any`\>

Object containing field definitions with current values

#### Inherited from

[`SmrtObject`](SmrtObject.md).[`getFields`](SmrtObject.md#getfields)

***

### getFieldValue()

> `protected` **getFieldValue**(`fieldName`): `any`

Defined in: [smrt/packages/core/src/object.ts:570](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L570)

Gets the value of a field on this object

#### Parameters

##### fieldName

`string`

#### Returns

`any`

#### Inherited from

[`SmrtObject`](SmrtObject.md).[`getFieldValue`](SmrtObject.md#getfieldvalue)

***

### getId()

> **getId**(): `Promise`\<`string`\>

Defined in: [smrt/packages/core/src/object.ts:374](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L374)

Gets or generates a unique ID for this object

#### Returns

`Promise`\<`string`\>

Promise resolving to the object's ID

#### Inherited from

[`SmrtObject`](SmrtObject.md).[`getId`](SmrtObject.md#getid)

***

### getPropertyValue()

> `protected` **getPropertyValue**(`key`): `any`

Defined in: [smrt/packages/core/src/object.ts:584](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L584)

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

[`SmrtObject`](SmrtObject.md).[`getPropertyValue`](SmrtObject.md#getpropertyvalue)

***

### getRelated()

> **getRelated**(`fieldName`): `Promise`\<`any`\>

Defined in: [smrt/packages/core/src/object.ts:957](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L957)

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

[`SmrtObject`](SmrtObject.md).[`getRelated`](SmrtObject.md#getrelated)

***

### getSavedId()

> **getSavedId**(): `Promise`\<`any`\>

Defined in: [smrt/packages/core/src/object.ts:413](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L413)

Gets the ID of this object if it's already saved in the database

#### Returns

`Promise`\<`any`\>

Promise resolving to the saved ID or null if not saved

#### Inherited from

[`SmrtObject`](SmrtObject.md).[`getSavedId`](SmrtObject.md#getsavedid)

***

### getSlug()

> **getSlug**(): `Promise`\<`string` \| `null` \| `undefined`\>

Defined in: [smrt/packages/core/src/object.ts:393](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L393)

Gets or generates a slug for this object based on its name

#### Returns

`Promise`\<`string` \| `null` \| `undefined`\>

Promise resolving to the object's slug

#### Inherited from

[`SmrtObject`](SmrtObject.md).[`getSlug`](SmrtObject.md#getslug)

***

### initialize()

> **initialize**(): `Promise`\<`Pleb`\>

Defined in: [smrt/packages/core/src/pleb.ts:62](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/pleb.ts#L62)

Initializes the Pleb instance and sets up database connections

#### Returns

`Promise`\<`Pleb`\>

Promise that resolves to this instance for chaining

#### Overrides

[`SmrtObject`](SmrtObject.md).[`initialize`](SmrtObject.md#initialize)

***

### is()

> **is**(`criteria`, `options`): `Promise`\<`any`\>

Defined in: [smrt/packages/core/src/object.ts:687](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L687)

Evaluates whether this object meets given criteria using AI

#### Parameters

##### criteria

`string`

Criteria to evaluate against

##### options

`any` = `{}`

AI message options

#### Returns

`Promise`\<`any`\>

Promise resolving to true if criteria are met, false otherwise

#### Throws

Error if the AI response is invalid

#### Inherited from

[`SmrtObject`](SmrtObject.md).[`is`](SmrtObject.md#is)

***

### isRelatedLoaded()

> **isRelatedLoaded**(`fieldName`): `boolean`

Defined in: [smrt/packages/core/src/object.ts:787](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L787)

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

[`SmrtObject`](SmrtObject.md).[`isRelatedLoaded`](SmrtObject.md#isrelatedloaded)

***

### isSaved()

> **isSaved**(): `Promise`\<`boolean`\>

Defined in: [smrt/packages/core/src/object.ts:425](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L425)

Checks if this object is already saved in the database

#### Returns

`Promise`\<`boolean`\>

Promise resolving to true if saved, false otherwise

#### Inherited from

[`SmrtObject`](SmrtObject.md).[`isSaved`](SmrtObject.md#issaved)

***

### loadDataFromDb()

> **loadDataFromDb**(`data`): `void`

Defined in: [smrt/packages/core/src/object.ts:291](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L291)

Loads data from a database row into this object's properties

#### Parameters

##### data

`any`

Database row data

#### Returns

`void`

#### Inherited from

[`SmrtObject`](SmrtObject.md).[`loadDataFromDb`](SmrtObject.md#loaddatafromdb)

***

### loadFromId()

> **loadFromId**(): `Promise`\<`void`\>

Defined in: [smrt/packages/core/src/object.ts:622](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L622)

Loads this object's data from the database using its ID

#### Returns

`Promise`\<`void`\>

Promise that resolves when loading is complete

#### Inherited from

[`SmrtObject`](SmrtObject.md).[`loadFromId`](SmrtObject.md#loadfromid)

***

### loadFromSlug()

> **loadFromSlug**(): `Promise`\<`void`\>

Defined in: [smrt/packages/core/src/object.ts:667](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L667)

Loads this object's data from the database using its slug and context

#### Returns

`Promise`\<`void`\>

Promise that resolves when loading is complete

#### Inherited from

[`SmrtObject`](SmrtObject.md).[`loadFromSlug`](SmrtObject.md#loadfromslug)

***

### loadRelated()

> **loadRelated**(`fieldName`): `Promise`\<`any`\>

Defined in: [smrt/packages/core/src/object.ts:807](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L807)

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

[`SmrtObject`](SmrtObject.md).[`loadRelated`](SmrtObject.md#loadrelated)

***

### loadRelatedMany()

> **loadRelatedMany**(`fieldName`): `Promise`\<`any`[]\>

Defined in: [smrt/packages/core/src/object.ts:872](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L872)

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

[`SmrtObject`](SmrtObject.md).[`loadRelatedMany`](SmrtObject.md#loadrelatedmany)

***

### recall()

> **recall**(`options`): `Promise`\<`any`\>

Defined in: [smrt/packages/core/src/object.ts:1117](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L1117)

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

[`SmrtObject`](SmrtObject.md).[`recall`](SmrtObject.md#recall)

***

### recallAll()

> **recallAll**(`options`): `Promise`\<`Map`\<`string`, `any`\>\>

Defined in: [smrt/packages/core/src/object.ts:1193](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L1193)

Recall all remembered context for this object in a scope

Returns a Map of key -> value for all context matching the criteria.
Useful for bulk retrieval of strategies or cached patterns.

#### Parameters

##### options

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

[`SmrtObject`](SmrtObject.md).[`recallAll`](SmrtObject.md#recallall)

***

### remember()

> **remember**(`options`): `Promise`\<`void`\>

Defined in: [smrt/packages/core/src/object.ts:1060](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L1060)

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

[`SmrtObject`](SmrtObject.md).[`remember`](SmrtObject.md#remember)

***

### runHook()

> `protected` **runHook**(`hookName`): `Promise`\<`void`\>

Defined in: [smrt/packages/core/src/object.ts:736](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L736)

Runs a lifecycle hook if it's defined in the object's configuration

#### Parameters

##### hookName

`string`

Name of the hook to run (e.g., 'beforeDelete', 'afterDelete')

#### Returns

`Promise`\<`void`\>

Promise that resolves when the hook completes

#### Inherited from

[`SmrtObject`](SmrtObject.md).[`runHook`](SmrtObject.md#runhook)

***

### save()

> **save**(): `Promise`\<`Pleb`\>

Defined in: [smrt/packages/core/src/object.ts:435](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L435)

Saves this object to the database

#### Returns

`Promise`\<`Pleb`\>

Promise resolving to this object

#### Inherited from

[`SmrtObject`](SmrtObject.md).[`save`](SmrtObject.md#save)

***

### toJSON()

> **toJSON**(): `any`

Defined in: [smrt/packages/core/src/object.ts:349](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L349)

Custom JSON serialization
Returns a plain object with all field values for proper JSON.stringify() behavior
Field instances automatically call their toJSON() method during serialization

#### Returns

`any`

#### Inherited from

[`SmrtObject`](SmrtObject.md).[`toJSON`](SmrtObject.md#tojson)

***

### validateBeforeSave()

> `protected` **validateBeforeSave**(): `Promise`\<`void`\>

Defined in: [smrt/packages/core/src/object.ts:528](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L528)

Validates object state before saving
Override in subclasses to add custom validation logic

#### Returns

`Promise`\<`void`\>

#### Inherited from

[`SmrtObject`](SmrtObject.md).[`validateBeforeSave`](SmrtObject.md#validatebeforesave)

***

### create()

> `static` **create**(`options`): `Promise`\<`Pleb`\>

Defined in: [smrt/packages/core/src/pleb.ts:51](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/pleb.ts#L51)

Creates and initializes a new Pleb instance

#### Parameters

##### options

[`PlebOptions`](../interfaces/PlebOptions.md)

Configuration options for the Pleb object

#### Returns

`Promise`\<`Pleb`\>

Promise resolving to the initialized Pleb instance

#### Example

```typescript
const pleb = await Pleb.create({
  name: 'Sample Object',
  db: { url: 'sqlite://data.db' }
});
```
