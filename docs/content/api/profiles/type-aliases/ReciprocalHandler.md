# Type Alias: ReciprocalHandler()

> **ReciprocalHandler** = (`from`, `to`, `context?`, `options?`) => `Promise`\<`void`\>

Defined in: [profiles/src/types.ts:13](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/profiles/src/types.ts#L13)

Handler function interface for reciprocal relationships

## Parameters

### from

`any`

The profile initiating the relationship

### to

`any`

The target profile

### context?

`any`

Optional context profile for tertiary relationships

### options?

`any`

Additional options for the handler

## Returns

`Promise`\<`void`\>
