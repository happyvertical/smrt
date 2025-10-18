# Class: Profile

Defined in: [profiles/src/models/Profile.ts:30](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/profiles/src/models/Profile.ts#L30)

## Extends

- `SmrtObject`

## Constructors

### Constructor

> **new Profile**(`options`): `Profile`

Defined in: [profiles/src/models/Profile.ts:42](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/profiles/src/models/Profile.ts#L42)

#### Parameters

##### options

`ProfileOptions` = `{}`

#### Returns

`Profile`

#### Overrides

`SmrtObject.constructor`

## Properties

### \_ai

> `protected` **\_ai**: `AIClient`

Defined in: [core/dist/class.d.ts:75](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/class.d.ts#L75)

AI client instance for interacting with AI models

#### Inherited from

`SmrtObject._ai`

***

### \_className

> `protected` **\_className**: `string`

Defined in: [core/dist/class.d.ts:87](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/class.d.ts#L87)

Class name used for identification

#### Inherited from

`SmrtObject._className`

***

### \_context

> `protected` **\_context**: `string` \| `null` \| `undefined`

Defined in: [core/dist/object.d.ts:79](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L79)

Optional context to scope the slug

#### Inherited from

`SmrtObject._context`

***

### \_db

> `protected` **\_db**: `DatabaseInterface`

Defined in: [core/dist/class.d.ts:83](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/class.d.ts#L83)

Database interface for data persistence

#### Inherited from

`SmrtObject._db`

***

### \_fs

> `protected` **\_fs**: `FilesystemAdapter`

Defined in: [core/dist/class.d.ts:79](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/class.d.ts#L79)

Filesystem adapter for file operations

#### Inherited from

`SmrtObject._fs`

***

### \_id

> `protected` **\_id**: `string` \| `null` \| `undefined`

Defined in: [core/dist/object.d.ts:71](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L71)

Unique identifier for the object

#### Inherited from

`SmrtObject._id`

***

### \_signalBus?

> `protected` `optional` **\_signalBus**: `SignalBus`

Defined in: [core/dist/class.d.ts:91](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/class.d.ts#L91)

Signal bus for method execution tracking

#### Inherited from

`SmrtObject._signalBus`

***

### \_slug

> `protected` **\_slug**: `string` \| `null` \| `undefined`

Defined in: [core/dist/object.d.ts:75](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L75)

URL-friendly identifier

#### Inherited from

`SmrtObject._slug`

***

### \_tableName

> **\_tableName**: `string`

Defined in: [core/dist/object.d.ts:57](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L57)

Database table name for this object

#### Inherited from

`SmrtObject._tableName`

***

### created\_at

> **created\_at**: `Date` \| `null` \| `undefined`

Defined in: [core/dist/object.d.ts:88](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L88)

Creation timestamp

#### Inherited from

`SmrtObject.created_at`

***

### description

> **description**: `Field`

Defined in: [profiles/src/models/Profile.ts:35](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/profiles/src/models/Profile.ts#L35)

***

### email

> **email**: `Field`

Defined in: [profiles/src/models/Profile.ts:33](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/profiles/src/models/Profile.ts#L33)

***

### metadata

> **metadata**: `Field`

Defined in: [profiles/src/models/Profile.ts:38](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/profiles/src/models/Profile.ts#L38)

***

### name

> **name**: `Field`

Defined in: [profiles/src/models/Profile.ts:34](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/profiles/src/models/Profile.ts#L34)

Human-readable name, primarily for display purposes
Can be a string value or a Field instance (for Field-based schema definition)

#### Overrides

`SmrtObject.name`

***

### options

> `protected` **options**: `SmrtObjectOptions`

Defined in: [core/dist/object.d.ts:67](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L67)

Override options with SmrtObjectOptions type for proper type narrowing.
Initialized by parent constructor via super() call.

#### Inherited from

`SmrtObject.options`

***

### relationshipsFrom

> **relationshipsFrom**: `Field`

Defined in: [profiles/src/models/Profile.ts:39](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/profiles/src/models/Profile.ts#L39)

***

### relationshipsTo

> **relationshipsTo**: `Field`

Defined in: [profiles/src/models/Profile.ts:40](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/profiles/src/models/Profile.ts#L40)

***

### typeId

> **typeId**: `Field`

Defined in: [profiles/src/models/Profile.ts:32](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/profiles/src/models/Profile.ts#L32)

***

### updated\_at

> **updated\_at**: `Date` \| `null` \| `undefined`

Defined in: [core/dist/object.d.ts:92](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L92)

Last update timestamp

#### Inherited from

`SmrtObject.updated_at`

## Accessors

### ai

#### Get Signature

> **get** **ai**(): `AIClient`

Defined in: [core/dist/class.d.ts:185](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/class.d.ts#L185)

Gets the AI client instance

##### Returns

`AIClient`

#### Inherited from

`SmrtObject.ai`

***

### context

#### Get Signature

> **get** **context**(): `string`

Defined in: [core/dist/object.d.ts:130](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L130)

Gets the context that scopes this object's slug

##### Returns

`string`

#### Set Signature

> **set** **context**(`value`): `void`

Defined in: [core/dist/object.d.ts:137](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L137)

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

Defined in: [core/dist/class.d.ts:181](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/class.d.ts#L181)

Gets the database interface instance

##### Returns

`DatabaseInterface`

#### Inherited from

`SmrtObject.db`

***

### fs

#### Get Signature

> **get** **fs**(): `FilesystemAdapter`

Defined in: [core/dist/class.d.ts:177](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/class.d.ts#L177)

Gets the filesystem adapter instance

##### Returns

`FilesystemAdapter`

#### Inherited from

`SmrtObject.fs`

***

### id

#### Get Signature

> **get** **id**(): `string` \| `null` \| `undefined`

Defined in: [core/dist/object.d.ts:108](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L108)

Gets the unique identifier for this object

##### Returns

`string` \| `null` \| `undefined`

#### Set Signature

> **set** **id**(`value`): `void`

Defined in: [core/dist/object.d.ts:115](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L115)

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

Defined in: [core/dist/class.d.ts:191](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/class.d.ts#L191)

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

Defined in: [core/dist/object.d.ts:119](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L119)

Gets the URL-friendly slug for this object

##### Returns

`string` \| `null` \| `undefined`

#### Set Signature

> **set** **slug**(`value`): `void`

Defined in: [core/dist/object.d.ts:126](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L126)

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

Defined in: [core/dist/class.d.ts:142](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/class.d.ts#L142)

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

Defined in: [core/dist/object.d.ts:163](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L163)

Gets the database table name for this object

##### Returns

`string`

#### Inherited from

`SmrtObject.tableName`

## Methods

### addMetadata()

> **addMetadata**(`metafieldSlug`, `value`): `Promise`\<`void`\>

Defined in: [profiles/src/models/Profile.ts:76](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/profiles/src/models/Profile.ts#L76)

Add metadata to this profile

#### Parameters

##### metafieldSlug

`string`

The slug of the metafield

##### value

`any`

The value to set

#### Returns

`Promise`\<`void`\>

***

### addRelationship()

> **addRelationship**(`toProfile`, `relationshipSlug`, `contextProfile?`): `Promise`\<`void`\>

Defined in: [profiles/src/models/Profile.ts:196](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/profiles/src/models/Profile.ts#L196)

Add a relationship to another profile

#### Parameters

##### toProfile

`Profile`

The target profile

##### relationshipSlug

`string`

The type of relationship

##### contextProfile?

`Profile`

Optional context profile for tertiary relationships

#### Returns

`Promise`\<`void`\>

***

### allDescriptors()

> **allDescriptors**(): `object` & `object`

Defined in: [core/dist/object.d.ts:155](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L155)

Gets all property descriptors from this object's prototype

#### Returns

`object` & `object`

Object containing all property descriptors

#### Inherited from

`SmrtObject.allDescriptors`

***

### delete()

> **delete**(): `Promise`\<`void`\>

Defined in: [core/dist/object.d.ts:271](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L271)

Delete this object from the database

#### Returns

`Promise`\<`void`\>

Promise that resolves when deletion is complete

#### Inherited from

`SmrtObject.delete`

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

`SmrtObject.destroy`

***

### do()

> **do**(`instructions`, `options?`): `Promise`\<`string`\>

Defined in: [core/dist/object.d.ts:258](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L258)

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

Defined in: [core/dist/object.d.ts:374](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L374)

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

Defined in: [core/dist/object.d.ts:229](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L229)

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

Defined in: [core/dist/object.d.ts:482](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L482)

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

Defined in: [core/dist/object.d.ts:504](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L504)

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

### generateBio()

> **generateBio**(): `Promise`\<`string`\>

Defined in: [profiles/src/models/Profile.ts:404](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/profiles/src/models/Profile.ts#L404)

AI-powered: Generate a professional bio for this profile

#### Returns

`Promise`\<`string`\>

Generated bio text

***

### getAvailableTools()

> **getAvailableTools**(): `AITool`[]

Defined in: [core/dist/object.d.ts:350](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L350)

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

Defined in: [core/dist/object.d.ts:169](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L169)

Gets field definitions and current values for this object

#### Returns

`Record`\<`string`, `any`\>

Object containing field definitions with current values

#### Inherited from

`SmrtObject.getFields`

***

### getFieldValue()

> `protected` **getFieldValue**(`fieldName`): `any`

Defined in: [core/dist/object.d.ts:214](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L214)

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

Defined in: [core/dist/object.d.ts:181](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L181)

Gets or generates a unique ID for this object

#### Returns

`Promise`\<`string`\>

Promise resolving to the object's ID

#### Inherited from

`SmrtObject.getId`

***

### getMetadata()

> **getMetadata**(): `Promise`\<`Record`\<`string`, `any`\>\>

Defined in: [profiles/src/models/Profile.ts:130](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/profiles/src/models/Profile.ts#L130)

Get all metadata for this profile as key-value object

#### Returns

`Promise`\<`Record`\<`string`, `any`\>\>

Object with metafield slugs as keys

***

### getPropertyValue()

> `protected` **getPropertyValue**(`key`): `any`

Defined in: [core/dist/object.d.ts:225](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L225)

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

Defined in: [core/dist/object.d.ts:336](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L336)

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

### getRelatedProfiles()

> **getRelatedProfiles**(`relationshipSlug?`): `Promise`\<`Profile`[]\>

Defined in: [profiles/src/models/Profile.ts:304](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/profiles/src/models/Profile.ts#L304)

Get related profiles

#### Parameters

##### relationshipSlug?

`string`

Optional filter by relationship type slug

#### Returns

`Promise`\<`Profile`[]\>

Array of related Profile instances

***

### getRelationships()

> **getRelationships**(`options?`): `Promise`\<`ProfileRelationship`[]\>

Defined in: [profiles/src/models/Profile.ts:259](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/profiles/src/models/Profile.ts#L259)

Get all relationships for this profile

#### Parameters

##### options?

Filter options (typeSlug, direction)

###### direction?

`"from"` \| `"to"` \| `"all"`

###### typeSlug?

`string`

#### Returns

`Promise`\<`ProfileRelationship`[]\>

Array of ProfileRelationship instances

***

### getSavedId()

> **getSavedId**(): `Promise`\<`any`\>

Defined in: [core/dist/object.d.ts:193](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L193)

Gets the ID of this object if it's already saved in the database

#### Returns

`Promise`\<`any`\>

Promise resolving to the saved ID or null if not saved

#### Inherited from

`SmrtObject.getSavedId`

***

### getSlug()

> **getSlug**(): `Promise`\<`string` \| `null` \| `undefined`\>

Defined in: [core/dist/object.d.ts:187](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L187)

Gets or generates a slug for this object based on its name

#### Returns

`Promise`\<`string` \| `null` \| `undefined`\>

Promise resolving to the object's slug

#### Inherited from

`SmrtObject.getSlug`

***

### getTypeSlug()

> **getTypeSlug**(): `Promise`\<`string`\>

Defined in: [profiles/src/models/Profile.ts:53](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/profiles/src/models/Profile.ts#L53)

Get the profile type slug for this profile

#### Returns

`Promise`\<`string`\>

The slug of the profile type

***

### initialize()

> **initialize**(): `Promise`\<`Profile`\>

Defined in: [core/dist/object.d.ts:143](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L143)

Initializes this object, setting up database tables and loading data if identifiers are provided

#### Returns

`Promise`\<`Profile`\>

Promise that resolves to this instance for chaining

#### Inherited from

`SmrtObject.initialize`

***

### is()

> **is**(`criteria`, `options?`): `Promise`\<`any`\>

Defined in: [core/dist/object.d.ts:250](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L250)

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

Defined in: [core/dist/object.d.ts:284](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L284)

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

Defined in: [core/dist/object.d.ts:199](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L199)

Checks if this object is already saved in the database

#### Returns

`Promise`\<`boolean`\>

Promise resolving to true if saved, false otherwise

#### Inherited from

`SmrtObject.isSaved`

***

### loadDataFromDb()

> **loadDataFromDb**(`data`): `void`

Defined in: [core/dist/object.d.ts:149](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L149)

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

Defined in: [core/dist/object.d.ts:235](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L235)

Loads this object's data from the database using its ID

#### Returns

`Promise`\<`void`\>

Promise that resolves when loading is complete

#### Inherited from

`SmrtObject.loadFromId`

***

### loadFromSlug()

> **loadFromSlug**(): `Promise`\<`void`\>

Defined in: [core/dist/object.d.ts:241](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L241)

Loads this object's data from the database using its slug and context

#### Returns

`Promise`\<`void`\>

Promise that resolves when loading is complete

#### Inherited from

`SmrtObject.loadFromSlug`

***

### loadRelated()

> **loadRelated**(`fieldName`): `Promise`\<`any`\>

Defined in: [core/dist/object.d.ts:301](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L301)

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

Defined in: [core/dist/object.d.ts:318](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L318)

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

### matches()

> **matches**(`criteria`): `Promise`\<`boolean`\>

Defined in: [profiles/src/models/Profile.ts:414](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/profiles/src/models/Profile.ts#L414)

AI-powered: Check if profile matches criteria

#### Parameters

##### criteria

`string`

Criteria to match against

#### Returns

`Promise`\<`boolean`\>

True if matches criteria

***

### recall()

> **recall**(`options`): `Promise`\<`any`\>

Defined in: [core/dist/object.d.ts:433](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L433)

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

Defined in: [core/dist/object.d.ts:460](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L460)

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

Defined in: [core/dist/object.d.ts:404](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L404)

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

### removeMetadata()

> **removeMetadata**(`metafieldSlug`): `Promise`\<`void`\>

Defined in: [profiles/src/models/Profile.ts:158](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/profiles/src/models/Profile.ts#L158)

Remove metadata by metafield slug

#### Parameters

##### metafieldSlug

`string`

The slug of the metafield to remove

#### Returns

`Promise`\<`void`\>

***

### removeRelationship()

> **removeRelationship**(`toProfile`, `relationshipSlug`): `Promise`\<`void`\>

Defined in: [profiles/src/models/Profile.ts:345](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/profiles/src/models/Profile.ts#L345)

Remove a relationship to another profile

#### Parameters

##### toProfile

`Profile`

The target profile

##### relationshipSlug

`string`

The type of relationship to remove

#### Returns

`Promise`\<`void`\>

***

### runHook()

> `protected` **runHook**(`hookName`): `Promise`\<`void`\>

Defined in: [core/dist/object.d.ts:265](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L265)

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

> **save**(): `Promise`\<`Profile`\>

Defined in: [core/dist/object.d.ts:205](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L205)

Saves this object to the database

#### Returns

`Promise`\<`Profile`\>

Promise resolving to this object

#### Inherited from

`SmrtObject.save`

***

### setTypeBySlug()

> **setTypeBySlug**(`slug`): `Promise`\<`void`\>

Defined in: [profiles/src/models/Profile.ts:64](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/profiles/src/models/Profile.ts#L64)

Set the profile type by slug

#### Parameters

##### slug

`string`

The slug of the profile type

#### Returns

`Promise`\<`void`\>

#### Throws

Error if profile type not found

***

### toJSON()

> **toJSON**(): `any`

Defined in: [core/dist/object.d.ts:175](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L175)

Custom JSON serialization
Returns a plain object with all field values for proper JSON.stringify() behavior
Field instances automatically call their toJSON() method during serialization

#### Returns

`any`

#### Inherited from

`SmrtObject.toJSON`

***

### updateMetadata()

> **updateMetadata**(`metadata`): `Promise`\<`void`\>

Defined in: [profiles/src/models/Profile.ts:147](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/profiles/src/models/Profile.ts#L147)

Update multiple metadata values

#### Parameters

##### metadata

`Record`\<`string`, `any`\>

Object with metafield slugs as keys and values

#### Returns

`Promise`\<`void`\>

***

### validateBeforeSave()

> `protected` **validateBeforeSave**(): `Promise`\<`void`\>

Defined in: [core/dist/object.d.ts:210](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L210)

Validates object state before saving
Override in subclasses to add custom validation logic

#### Returns

`Promise`\<`void`\>

#### Inherited from

`SmrtObject.validateBeforeSave`

***

### findByMetadata()

> `static` **findByMetadata**(`_metafieldSlug`, `_value`): `Promise`\<`Profile`[]\>

Defined in: [profiles/src/models/Profile.ts:425](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/profiles/src/models/Profile.ts#L425)

Find profiles by metadata key-value pair

#### Parameters

##### \_metafieldSlug

`string`

##### \_value

`any`

#### Returns

`Promise`\<`Profile`[]\>

Array of matching profiles

***

### findByType()

> `static` **findByType**(`_typeSlug`): `Promise`\<`Profile`[]\>

Defined in: [profiles/src/models/Profile.ts:439](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/profiles/src/models/Profile.ts#L439)

Find profiles by type slug

#### Parameters

##### \_typeSlug

`string`

#### Returns

`Promise`\<`Profile`[]\>

Array of matching profiles

***

### findRelated()

> `static` **findRelated**(`_profileId`, `_relationshipSlug?`): `Promise`\<`Profile`[]\>

Defined in: [profiles/src/models/Profile.ts:451](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/profiles/src/models/Profile.ts#L451)

Find related profiles for a given profile

#### Parameters

##### \_profileId

`string`

##### \_relationshipSlug?

`string`

#### Returns

`Promise`\<`Profile`[]\>

Array of related profiles

***

### searchByEmail()

> `static` **searchByEmail**(`_email`): `Promise`\<`Profile` \| `null`\>

Defined in: [profiles/src/models/Profile.ts:465](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/profiles/src/models/Profile.ts#L465)

Search profiles by email

#### Parameters

##### \_email

`string`

#### Returns

`Promise`\<`Profile` \| `null`\>

Profile or null if not found
