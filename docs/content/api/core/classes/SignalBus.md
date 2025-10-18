# Class: SignalBus

Defined in: [smrt/packages/core/src/signals/bus.ts:19](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/signals/bus.ts#L19)

Central signal distribution bus

SignalBus manages adapter registration and signal distribution
with fire-and-forget error handling.

## Constructors

### Constructor

> **new SignalBus**(`options?`): `SignalBus`

Defined in: [smrt/packages/core/src/signals/bus.ts:28](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/signals/bus.ts#L28)

Create a new SignalBus

#### Parameters

##### options?

Configuration options

###### sanitization?

`false` \| [`SanitizationConfig`](../interfaces/SanitizationConfig.md)

#### Returns

`SignalBus`

## Accessors

### adapterCount

#### Get Signature

> **get** **adapterCount**(): `number`

Defined in: [smrt/packages/core/src/signals/bus.ts:132](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/signals/bus.ts#L132)

Get count of registered adapters

##### Returns

`number`

Number of registered adapters

## Methods

### clear()

> **clear**(): `void`

Defined in: [smrt/packages/core/src/signals/bus.ts:65](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/signals/bus.ts#L65)

Clear all registered adapters

Removes all adapters from the bus. Useful for cleanup or testing.

#### Returns

`void`

***

### emit()

> **emit**(`signal`): `Promise`\<`void`\>

Defined in: [smrt/packages/core/src/signals/bus.ts:78](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/signals/bus.ts#L78)

Emit a signal to all registered adapters

Signals are sanitized (if configured) before being passed to adapters.
Adapters are called in fire-and-forget mode - errors are logged
but don't interrupt the main execution flow.

#### Parameters

##### signal

`Signal`

Signal to emit

#### Returns

`Promise`\<`void`\>

***

### generateExecutionId()

> **generateExecutionId**(): `string`

Defined in: [smrt/packages/core/src/signals/bus.ts:123](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/signals/bus.ts#L123)

Generate unique execution ID for method invocations

#### Returns

`string`

Unique execution ID (CUID2)

***

### register()

> **register**(`adapter`): `void`

Defined in: [smrt/packages/core/src/signals/bus.ts:39](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/signals/bus.ts#L39)

Register a signal adapter

#### Parameters

##### adapter

`SignalAdapter`

Adapter to register

#### Returns

`void`

***

### unregister()

> **unregister**(`adapter`): `boolean`

Defined in: [smrt/packages/core/src/signals/bus.ts:51](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/signals/bus.ts#L51)

Unregister a signal adapter

Removes the adapter from the bus to prevent memory leaks.

#### Parameters

##### adapter

`SignalAdapter`

Adapter to unregister

#### Returns

`boolean`

True if adapter was found and removed
