# Interface: Signal

Defined in: packages/types/dist/index.d.ts:8

Signal emitted during SMRT method execution

Signals provide automatic observability into method execution,
enabling logging, metrics, pub/sub updates, and other integrations
without requiring manual instrumentation.

## Properties

### args?

> `optional` **args**: `any`[]

Defined in: packages/types/dist/index.d.ts:43

Sanitized method arguments (sensitive data removed)
Objects with

#### Sensitive

JSDoc tags are excluded

***

### className

> **className**: `string`

Defined in: packages/types/dist/index.d.ts:21

Name of the SMRT class

***

### duration?

> `optional` **duration**: `number`

Defined in: packages/types/dist/index.d.ts:56

Method execution duration in milliseconds
Only present on 'end' and 'error' signals

***

### error?

> `optional` **error**: `Error`

Defined in: packages/types/dist/index.d.ts:51

Error that was thrown (only present on 'error' signals)

***

### id

> **id**: `string`

Defined in: packages/types/dist/index.d.ts:13

Unique identifier for this specific execution
Generated once per method invocation

***

### metadata?

> `optional` **metadata**: `Record`\<`string`, `any`\>

Defined in: packages/types/dist/index.d.ts:65

Optional additional context
Can include tracing IDs, user context, request metadata, etc.

***

### method

> **method**: `string`

Defined in: packages/types/dist/index.d.ts:25

Name of the method being executed

***

### objectId

> **objectId**: `string`

Defined in: packages/types/dist/index.d.ts:17

ID of the SMRT object instance

***

### result?

> `optional` **result**: `any`

Defined in: packages/types/dist/index.d.ts:47

Method result (only present on 'end' signals)

***

### step?

> `optional` **step**: `string`

Defined in: packages/types/dist/index.d.ts:38

Optional step label for manual progress tracking
Developers can emit custom steps within methods using bus.emit()

***

### timestamp

> **timestamp**: `Date`

Defined in: packages/types/dist/index.d.ts:60

Timestamp when signal was emitted

***

### type

> **type**: [`SignalType`](../type-aliases/SignalType.md)

Defined in: packages/types/dist/index.d.ts:33

Signal type indicating lifecycle stage:
- 'start': Method execution started
- 'step': Manual step within method (optional)
- 'end': Method execution completed successfully
- 'error': Method execution failed
