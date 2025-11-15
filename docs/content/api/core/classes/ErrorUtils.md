# Class: ErrorUtils

Defined in: [packages/core/src/errors.ts:487](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/errors.ts#L487)

Utility functions for error handling

## Constructors

### Constructor

> **new ErrorUtils**(): `ErrorUtils`

#### Returns

`ErrorUtils`

## Methods

### isRetryable()

> `static` **isRetryable**(`error`): `boolean`

Defined in: [packages/core/src/errors.ts:536](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/errors.ts#L536)

Checks if an error is retryable

#### Parameters

##### error

`Error`

#### Returns

`boolean`

***

### sanitizeError()

> `static` **sanitizeError**(`error`): `Record`\<`string`, `any`\>

Defined in: [packages/core/src/errors.ts:559](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/errors.ts#L559)

Sanitizes an error for safe logging (removes sensitive information)

#### Parameters

##### error

`Error`

#### Returns

`Record`\<`string`, `any`\>

***

### withRetry()

> `static` **withRetry**\<`T`\>(`operation`, `maxRetries`, `delay`, `backoffMultiplier`): `Promise`\<`T`\>

Defined in: [packages/core/src/errors.ts:491](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/errors.ts#L491)

Wraps a function with error handling and automatic retry logic

#### Type Parameters

##### T

`T`

#### Parameters

##### operation

() => `Promise`\<`T`\>

##### maxRetries

`number` = `3`

##### delay

`number` = `1000`

##### backoffMultiplier

`number` = `2`

#### Returns

`Promise`\<`T`\>
