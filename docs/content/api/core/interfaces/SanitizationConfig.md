# Interface: SanitizationConfig

Defined in: [smrt/packages/core/src/signals/sanitizer.ts:13](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/signals/sanitizer.ts#L13)

Sanitization configuration

## Properties

### maxStackLines?

> `optional` **maxStackLines**: `number`

Defined in: [smrt/packages/core/src/signals/sanitizer.ts:36](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/signals/sanitizer.ts#L36)

Maximum number of stack trace lines to include in sanitized errors
Default: 10

***

### redactedValue?

> `optional` **redactedValue**: `string`

Defined in: [smrt/packages/core/src/signals/sanitizer.ts:30](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/signals/sanitizer.ts#L30)

Replacement value for redacted fields
Default: '[REDACTED]'

***

### redactKeys?

> `optional` **redactKeys**: `string`[]

Defined in: [smrt/packages/core/src/signals/sanitizer.ts:18](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/signals/sanitizer.ts#L18)

Keys to redact from signal payloads
Default: common sensitive fields

***

### replacer()?

> `optional` **replacer**: (`key`, `value`) => `any`

Defined in: [smrt/packages/core/src/signals/sanitizer.ts:24](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/signals/sanitizer.ts#L24)

Custom replacer function for sanitization
Return undefined to redact the value entirely

#### Parameters

##### key

`string`

##### value

`any`

#### Returns

`any`
