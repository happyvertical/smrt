# Interface: SignalAdapter

Defined in: packages/types/dist/index.d.ts:80

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

Defined in: packages/types/dist/index.d.ts:91

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
