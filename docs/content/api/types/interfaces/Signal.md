# Interface: Signal

Defined in: [signals.ts:21](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/types/src/signals.ts#L21)

Signal emitted during SMRT method execution

Signals provide automatic observability into method execution,
enabling logging, metrics, pub/sub updates, and other integrations
without requiring manual instrumentation.

## Properties

### args?

> `optional` **args**: `any`[]

Defined in: [signals.ts:62](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/types/src/signals.ts#L62)

Sanitized method arguments (sensitive data removed)
Objects with

#### Sensitive

JSDoc tags are excluded

***

### className

> **className**: `string`

Defined in: [signals.ts:36](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/types/src/signals.ts#L36)

Name of the SMRT class

***

### duration?

> `optional` **duration**: `number`

Defined in: [signals.ts:78](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/types/src/signals.ts#L78)

Method execution duration in milliseconds
Only present on 'end' and 'error' signals

***

### error?

> `optional` **error**: `Error`

Defined in: [signals.ts:72](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/types/src/signals.ts#L72)

Error that was thrown (only present on 'error' signals)

***

### id

> **id**: `string`

Defined in: [signals.ts:26](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/types/src/signals.ts#L26)

Unique identifier for this specific execution
Generated once per method invocation

***

### metadata?

> `optional` **metadata**: `Record`\<`string`, `any`\>

Defined in: [signals.ts:89](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/types/src/signals.ts#L89)

Optional additional context
Can include tracing IDs, user context, request metadata, etc.

***

### method

> **method**: `string`

Defined in: [signals.ts:41](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/types/src/signals.ts#L41)

Name of the method being executed

***

### objectId

> **objectId**: `string`

Defined in: [signals.ts:31](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/types/src/signals.ts#L31)

ID of the SMRT object instance

***

### result?

> `optional` **result**: `any`

Defined in: [signals.ts:67](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/types/src/signals.ts#L67)

Method result (only present on 'end' signals)

***

### step?

> `optional` **step**: `string`

Defined in: [signals.ts:56](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/types/src/signals.ts#L56)

Optional step label for manual progress tracking
Developers can emit custom steps within methods using bus.emit()

***

### timestamp

> **timestamp**: `Date`

Defined in: [signals.ts:83](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/types/src/signals.ts#L83)

Timestamp when signal was emitted

***

### type

> **type**: [`SignalType`](../type-aliases/SignalType.md)

Defined in: [signals.ts:50](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/types/src/signals.ts#L50)

Signal type indicating lifecycle stage:
- 'start': Method execution started
- 'step': Manual step within method (optional)
- 'end': Method execution completed successfully
- 'error': Method execution failed
