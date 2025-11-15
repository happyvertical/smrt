# Interface: MethodMetrics

Defined in: [packages/core/src/adapters/metrics.ts:13](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/adapters/metrics.ts#L13)

Execution metrics for a specific method

## Properties

### count

> **count**: `number`

Defined in: [packages/core/src/adapters/metrics.ts:15](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/adapters/metrics.ts#L15)

Total number of executions

***

### errorCount

> **errorCount**: `number`

Defined in: [packages/core/src/adapters/metrics.ts:19](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/adapters/metrics.ts#L19)

Number of failed executions

***

### lastExecuted

> **lastExecuted**: `number`

Defined in: [packages/core/src/adapters/metrics.ts:27](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/adapters/metrics.ts#L27)

Last execution timestamp

***

### maxDuration

> **maxDuration**: `number`

Defined in: [packages/core/src/adapters/metrics.ts:25](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/adapters/metrics.ts#L25)

Maximum execution time (ms)

***

### minDuration

> **minDuration**: `number`

Defined in: [packages/core/src/adapters/metrics.ts:23](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/adapters/metrics.ts#L23)

Minimum execution time (ms)

***

### successCount

> **successCount**: `number`

Defined in: [packages/core/src/adapters/metrics.ts:17](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/adapters/metrics.ts#L17)

Number of successful executions

***

### totalDuration

> **totalDuration**: `number`

Defined in: [packages/core/src/adapters/metrics.ts:21](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/adapters/metrics.ts#L21)

Total execution time across all calls (ms)
