# Class: ErrorUtils

Defined in: [smrt/packages/core/src/errors.ts:417](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/errors.ts#L417)

Utility functions for error handling

## Constructors

### Constructor

> **new ErrorUtils**(): `ErrorUtils`

#### Returns

`ErrorUtils`

## Methods

### isRetryable()

> `static` **isRetryable**(`error`): `boolean`

Defined in: [smrt/packages/core/src/errors.ts:460](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/errors.ts#L460)

Checks if an error is retryable

#### Parameters

##### error

`Error`

#### Returns

`boolean`

***

### sanitizeError()

> `static` **sanitizeError**(`error`): `Record`\<`string`, `any`\>

Defined in: [smrt/packages/core/src/errors.ts:483](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/errors.ts#L483)

Sanitizes an error for safe logging (removes sensitive information)

#### Parameters

##### error

`Error`

#### Returns

`Record`\<`string`, `any`\>

***

### withRetry()

> `static` **withRetry**\<`T`\>(`operation`, `maxRetries`, `delay`, `backoffMultiplier`): `Promise`\<`T`\>

Defined in: [smrt/packages/core/src/errors.ts:421](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/errors.ts#L421)

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
