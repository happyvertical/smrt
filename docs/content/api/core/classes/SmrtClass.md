# Class: SmrtClass

Defined in: [smrt/packages/core/src/class.ts:93](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/class.ts#L93)

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

Defined in: [smrt/packages/core/src/class.ts:140](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/class.ts#L140)

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

Defined in: [smrt/packages/core/src/class.ts:97](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/class.ts#L97)

AI client instance for interacting with AI models

***

### \_className

> `protected` **\_className**: `string`

Defined in: [smrt/packages/core/src/class.ts:112](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/class.ts#L112)

Class name used for identification

***

### \_db

> `protected` **\_db**: `DatabaseInterface`

Defined in: [smrt/packages/core/src/class.ts:107](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/class.ts#L107)

Database interface for data persistence

***

### \_fs

> `protected` **\_fs**: `FilesystemAdapter`

Defined in: [smrt/packages/core/src/class.ts:102](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/class.ts#L102)

Filesystem adapter for file operations

***

### \_signalBus?

> `protected` `optional` **\_signalBus**: [`SignalBus`](SignalBus.md)

Defined in: [smrt/packages/core/src/class.ts:117](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/class.ts#L117)

Signal bus for method execution tracking

***

### options

> `protected` **options**: [`SmrtClassOptions`](../interfaces/SmrtClassOptions.md)

Defined in: [smrt/packages/core/src/class.ts:127](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/class.ts#L127)

Configuration options provided to the class

## Accessors

### ai

#### Get Signature

> **get** **ai**(): `AIClient`

Defined in: [smrt/packages/core/src/class.ts:388](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/class.ts#L388)

Gets the AI client instance

##### Returns

`AIClient`

***

### db

#### Get Signature

> **get** **db**(): `DatabaseInterface`

Defined in: [smrt/packages/core/src/class.ts:381](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/class.ts#L381)

Gets the database interface instance

##### Returns

`DatabaseInterface`

***

### fs

#### Get Signature

> **get** **fs**(): `FilesystemAdapter`

Defined in: [smrt/packages/core/src/class.ts:374](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/class.ts#L374)

Gets the filesystem adapter instance

##### Returns

`FilesystemAdapter`

***

### signalBus

#### Get Signature

> **get** **signalBus**(): [`SignalBus`](SignalBus.md) \| `undefined`

Defined in: [smrt/packages/core/src/class.ts:397](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/class.ts#L397)

Gets the signal bus instance

##### Returns

[`SignalBus`](SignalBus.md) \| `undefined`

Signal bus if signals are enabled, undefined otherwise

***

### systemDb

#### Get Signature

> **get** `protected` **systemDb**(): `DatabaseInterface`

Defined in: [smrt/packages/core/src/class.ts:255](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/class.ts#L255)

Access system tables through standard database interface
System tables use _smrt_ prefix to avoid conflicts with user tables

##### Returns

`DatabaseInterface`

## Methods

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

***

### initialize()

> `protected` **initialize**(): `Promise`\<`SmrtClass`\>

Defined in: [smrt/packages/core/src/class.ts:153](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/class.ts#L153)

Initializes database, filesystem, and AI client connections

This method sets up all required services based on the provided options.
It should be called before using any of the service interfaces.

#### Returns

`Promise`\<`SmrtClass`\>

Promise that resolves to this instance for chaining
