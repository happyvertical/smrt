# Interface: SignalAdapter

Defined in: [signals.ts:104](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/types/src/signals.ts#L104)

Adapter interface for consuming signals

Adapters process signals for specific purposes like:
- Logging: Write to console, file, or logging service
- Metrics: Track execution counts, durations, errors
- Pub/Sub: Broadcast real-time updates to clients
- Tracing: Send spans to distributed tracing systems

Adapters are fire-and-forget - errors are caught and logged
but don't interrupt the main execution flow.

## Methods

### handle()

> **handle**(`signal`): `Promise`\<`void`\>

Defined in: [signals.ts:115](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/types/src/signals.ts#L115)

Handle a signal event

#### Parameters

##### signal

[`Signal`](Signal.md)

The signal to process

#### Returns

`Promise`\<`void`\>

Promise that resolves when signal is handled

#### Remarks

This method should not throw - errors are caught by the SignalBus.
Implementations should handle their own error logging/recovery.
