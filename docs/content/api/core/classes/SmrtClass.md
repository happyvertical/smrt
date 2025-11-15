# Class: SmrtClass

Defined in: [packages/core/src/class.ts:108](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L108)

Foundation class providing core functionality for the SMRT framework

SmrtClass provides unified access to database, filesystem, and AI client
interfaces. It serves as the foundation for all other classes in the
SMRT framework.

## Extended by

- [`SmrtCollection`](SmrtCollection.md)
- [`SmrtObject`](SmrtObject.md)

## Constructors

### Constructor

> **new SmrtClass**(`options`): `SmrtClass`

Defined in: [packages/core/src/class.ts:157](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L157)

Creates a new SmrtClass instance

#### Parameters

##### options

[`SmrtClassOptions`](../interfaces/SmrtClassOptions.md) = `{}`

Configuration options for database, filesystem, and AI clients

#### Returns

`SmrtClass`

## Properties

### \_ai

> `protected` **\_ai**: `AIClient`

Defined in: [packages/core/src/class.ts:112](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L112)

AI client instance for interacting with AI models

***

### \_className

> `protected` **\_className**: `string`

Defined in: [packages/core/src/class.ts:127](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L127)

Class name used for identification

***

### \_db

> `protected` **\_db**: `DatabaseInterface`

Defined in: [packages/core/src/class.ts:122](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L122)

Database interface for data persistence

***

### \_fs

> `protected` **\_fs**: `FilesystemAdapter`

Defined in: [packages/core/src/class.ts:117](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L117)

Filesystem adapter for file operations

***

### \_signalBus?

> `protected` `optional` **\_signalBus**: [`SignalBus`](SignalBus.md)

Defined in: [packages/core/src/class.ts:132](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L132)

Signal bus for method execution tracking

***

### options

> **options**: [`SmrtClassOptions`](../interfaces/SmrtClassOptions.md)

Defined in: [packages/core/src/class.ts:142](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L142)

Configuration options provided to the class

## Accessors

### ai

#### Get Signature

> **get** **ai**(): `AIClient`

Defined in: [packages/core/src/class.ts:507](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L507)

Gets the AI client instance

##### Returns

`AIClient`

***

### db

#### Get Signature

> **get** **db**(): `DatabaseInterface`

Defined in: [packages/core/src/class.ts:493](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L493)

Gets the database interface instance

##### Returns

`DatabaseInterface`

***

### fs

#### Get Signature

> **get** **fs**(): `FilesystemAdapter`

Defined in: [packages/core/src/class.ts:486](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L486)

Gets the filesystem adapter instance

##### Returns

`FilesystemAdapter`

***

### signalBus

#### Get Signature

> **get** **signalBus**(): [`SignalBus`](SignalBus.md) \| `undefined`

Defined in: [packages/core/src/class.ts:516](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L516)

Gets the signal bus instance

##### Returns

[`SignalBus`](SignalBus.md) \| `undefined`

Signal bus if signals are enabled, undefined otherwise

***

### systemDb

#### Get Signature

> **get** `protected` **systemDb**(): `DatabaseInterface`

Defined in: [packages/core/src/class.ts:365](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L365)

Access system tables through standard database interface
System tables use _smrt_ prefix to avoid conflicts with user tables

##### Returns

`DatabaseInterface`

## Methods

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

***

### initialize()

> `protected` **initialize**(): `Promise`\<`SmrtClass`\>

Defined in: [packages/core/src/class.ts:191](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L191)

Initializes database, filesystem, and AI client connections

This method sets up all required services based on the provided options.
It should be called before using any of the service interfaces.

#### Returns

`Promise`\<`SmrtClass`\>

Promise that resolves to this instance for chaining

#### Throws

If database is required but not provided in options

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
