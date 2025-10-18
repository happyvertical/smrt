# Class: MetricsAdapter

Defined in: smrt/packages/core/src/adapters/metrics.ts:60

Metrics Adapter - Tracks execution metrics for observability

Provides Prometheus-style metrics for SMRT method executions:
- Execution counts (total, success, error)
- Duration statistics (min, max, avg)
- Success/error rates

## Example

```typescript
const metrics = new MetricsAdapter();
signalBus.register(metrics);

// Later, get metrics snapshot
const snapshot = metrics.getMetrics();
console.log(snapshot.methods['Product.analyze']);
```

## Implements

- [`Signal`](../type-aliases/Signal.md)

## Constructors

### Constructor

> **new MetricsAdapter**(): `MetricsAdapter`

#### Returns

`MetricsAdapter`

## Methods

### getAverageDuration()

> **getAverageDuration**(`className`, `methodName`): `number`

Defined in: smrt/packages/core/src/adapters/metrics.ts:161

Get average duration for a method

#### Parameters

##### className

`string`

Class name

##### methodName

`string`

Method name

#### Returns

`number`

Average duration in ms, or 0 if no executions

***

### getErrorRate()

> **getErrorRate**(`className`, `methodName`): `number`

Defined in: smrt/packages/core/src/adapters/metrics.ts:191

Get error rate for a method

#### Parameters

##### className

`string`

Class name

##### methodName

`string`

Method name

#### Returns

`number`

Error rate (0-1), or 0 if no executions

***

### getMethodMetrics()

> **getMethodMetrics**(`className`, `methodName`): [`MethodMetrics`](../interfaces/MethodMetrics.md) \| `undefined`

Defined in: smrt/packages/core/src/adapters/metrics.ts:145

Get metrics for a specific method

#### Parameters

##### className

`string`

Class name

##### methodName

`string`

Method name

#### Returns

[`MethodMetrics`](../interfaces/MethodMetrics.md) \| `undefined`

Metrics for the method, or undefined if not found

***

### getMetrics()

> **getMetrics**(): [`MetricsSnapshot`](../interfaces/MetricsSnapshot.md)

Defined in: smrt/packages/core/src/adapters/metrics.ts:124

Get current metrics snapshot

#### Returns

[`MetricsSnapshot`](../interfaces/MetricsSnapshot.md)

Snapshot of all collected metrics

***

### getSuccessRate()

> **getSuccessRate**(`className`, `methodName`): `number`

Defined in: smrt/packages/core/src/adapters/metrics.ts:176

Get success rate for a method

#### Parameters

##### className

`string`

Class name

##### methodName

`string`

Method name

#### Returns

`number`

Success rate (0-1), or 0 if no executions

***

### handle()

> **handle**(`signal`): `Promise`\<`void`\>

Defined in: smrt/packages/core/src/adapters/metrics.ts:70

Handle a signal and update metrics

#### Parameters

##### signal

`Signal`

Signal to process

#### Returns

`Promise`\<`void`\>

***

### reset()

> **reset**(): `void`

Defined in: smrt/packages/core/src/adapters/metrics.ts:257

Reset all metrics

Clears all collected metrics and resets counters.

#### Returns

`void`

***

### toPrometheusFormat()

> **toPrometheusFormat**(): `string`

Defined in: smrt/packages/core/src/adapters/metrics.ts:204

Export metrics in Prometheus text format

#### Returns

`string`

Prometheus-compatible metrics text
