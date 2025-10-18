# Interface: Subscription

Defined in: [smrt/packages/core/src/adapters/pubsub.ts:26](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/adapters/pubsub.ts#L26)

Subscription configuration

## Properties

### callback

> **callback**: [`SignalSubscriber`](../type-aliases/SignalSubscriber.md)

Defined in: [smrt/packages/core/src/adapters/pubsub.ts:30](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/adapters/pubsub.ts#L30)

Callback to invoke with signals

***

### filter?

> `optional` **filter**: [`SignalFilter`](../type-aliases/SignalFilter.md)

Defined in: [smrt/packages/core/src/adapters/pubsub.ts:32](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/adapters/pubsub.ts#L32)

Optional filter to apply before sending

***

### id

> **id**: `string`

Defined in: [smrt/packages/core/src/adapters/pubsub.ts:28](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/adapters/pubsub.ts#L28)

Unique subscription ID
