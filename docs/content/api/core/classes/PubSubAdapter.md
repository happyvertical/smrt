# Class: PubSubAdapter

Defined in: [packages/core/src/adapters/pubsub.ts:62](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/adapters/pubsub.ts#L62)

Pub/Sub Adapter - Broadcasts signals to subscribers

Enables real-time updates for UI clients via WebSocket/SSE or
internal event-driven architectures via callbacks.

Features:
- Multiple subscribers with independent filters
- Fire-and-forget delivery (errors don't block other subscribers)
- Flexible filtering (by class, method, type, etc.)
- Subscription management (add, remove, list)

## Example

```typescript
const pubsub = new PubSubAdapter();
signalBus.register(pubsub);

// Subscribe to all error signals
const subId = pubsub.subscribe(
  (signal) => console.error('Error:', signal),
  (signal) => signal.type === 'error'
);

// Later, unsubscribe
pubsub.unsubscribe(subId);
```

## Implements

- [`SignalAdapter`](../interfaces/SignalAdapter.md)

## Constructors

### Constructor

> **new PubSubAdapter**(): `PubSubAdapter`

#### Returns

`PubSubAdapter`

## Accessors

### subscriberCount

#### Get Signature

> **get** **subscriberCount**(): `number`

Defined in: [packages/core/src/adapters/pubsub.ts:134](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/adapters/pubsub.ts#L134)

Get count of active subscriptions

##### Returns

`number`

Number of active subscribers

## Methods

### clearSubscriptions()

> **clearSubscriptions**(): `void`

Defined in: [packages/core/src/adapters/pubsub.ts:143](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/adapters/pubsub.ts#L143)

Clear all subscriptions

Removes all subscribers. Useful for cleanup or testing.

#### Returns

`void`

***

### handle()

> **handle**(`signal`): `Promise`\<`void`\>

Defined in: [packages/core/src/adapters/pubsub.ts:71](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/adapters/pubsub.ts#L71)

Handle a signal and broadcast to subscribers

#### Parameters

##### signal

[`Signal`](../interfaces/Signal.md)

Signal to broadcast

#### Returns

`Promise`\<`void`\>

#### Implementation of

[`SignalAdapter`](../interfaces/SignalAdapter.md).[`handle`](../interfaces/SignalAdapter.md#handle)

***

### subscribe()

> **subscribe**(`callback`, `filter?`): `string`

Defined in: [packages/core/src/adapters/pubsub.ts:107](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/adapters/pubsub.ts#L107)

Subscribe to signals

#### Parameters

##### callback

[`SignalSubscriber`](../type-aliases/SignalSubscriber.md)

Function to call with matching signals

##### filter?

[`SignalFilter`](../type-aliases/SignalFilter.md)

Optional filter to apply before sending

#### Returns

`string`

Subscription ID for later unsubscribe

***

### unsubscribe()

> **unsubscribe**(`subscriptionId`): `boolean`

Defined in: [packages/core/src/adapters/pubsub.ts:125](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/adapters/pubsub.ts#L125)

Unsubscribe from signals

#### Parameters

##### subscriptionId

`string`

ID returned from subscribe()

#### Returns

`boolean`

True if subscription was found and removed

***

### combineFilters()

> `static` **combineFilters**(...`filters`): [`SignalFilter`](../type-aliases/SignalFilter.md)

Defined in: [packages/core/src/adapters/pubsub.ts:198](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/adapters/pubsub.ts#L198)

Combine multiple filters with AND logic

#### Parameters

##### filters

...[`SignalFilter`](../type-aliases/SignalFilter.md)[]

Filters to combine

#### Returns

[`SignalFilter`](../type-aliases/SignalFilter.md)

Combined filter function

***

### filterByClass()

> `static` **filterByClass**(`className`): [`SignalFilter`](../type-aliases/SignalFilter.md)

Defined in: [packages/core/src/adapters/pubsub.ts:153](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/adapters/pubsub.ts#L153)

Create filter for specific class

#### Parameters

##### className

`string`

Class name to match

#### Returns

[`SignalFilter`](../type-aliases/SignalFilter.md)

Filter function

***

### filterByClassAndMethod()

> `static` **filterByClassAndMethod**(`className`, `methodName`): [`SignalFilter`](../type-aliases/SignalFilter.md)

Defined in: [packages/core/src/adapters/pubsub.ts:184](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/adapters/pubsub.ts#L184)

Create filter for specific class and method

#### Parameters

##### className

`string`

Class name to match

##### methodName

`string`

Method name to match

#### Returns

[`SignalFilter`](../type-aliases/SignalFilter.md)

Filter function

***

### filterByMethod()

> `static` **filterByMethod**(`methodName`): [`SignalFilter`](../type-aliases/SignalFilter.md)

Defined in: [packages/core/src/adapters/pubsub.ts:163](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/adapters/pubsub.ts#L163)

Create filter for specific method

#### Parameters

##### methodName

`string`

Method name to match

#### Returns

[`SignalFilter`](../type-aliases/SignalFilter.md)

Filter function

***

### filterByType()

> `static` **filterByType**(`type`): [`SignalFilter`](../type-aliases/SignalFilter.md)

Defined in: [packages/core/src/adapters/pubsub.ts:173](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/adapters/pubsub.ts#L173)

Create filter for specific signal type

#### Parameters

##### type

Signal type to match

`"start"` | `"step"` | `"end"` | `"error"`

#### Returns

[`SignalFilter`](../type-aliases/SignalFilter.md)

Filter function
