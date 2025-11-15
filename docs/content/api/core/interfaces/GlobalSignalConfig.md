# Interface: GlobalSignalConfig

Defined in: [packages/core/src/config.ts:69](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/config.ts#L69)

Global signal configuration

Application-level defaults for signal adapters.
These can be overridden per-instance via SmrtClassOptions.

## Properties

### ai?

> `optional` **ai**: `AIConfig`

Defined in: [packages/core/src/config.ts:83](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/config.ts#L83)

AI provider configuration (default: undefined)
Provides global defaults for AI client initialization

***

### logging?

> `optional` **logging**: `LoggerConfig`

Defined in: [packages/core/src/config.ts:71](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/config.ts#L71)

Logging configuration (default: true with console, info level)

***

### metrics?

> `optional` **metrics**: [`MetricsConfig`](MetricsConfig.md)

Defined in: [packages/core/src/config.ts:74](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/config.ts#L74)

Metrics configuration (default: undefined/disabled)

***

### pubsub?

> `optional` **pubsub**: [`PubSubConfig`](PubSubConfig.md)

Defined in: [packages/core/src/config.ts:77](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/config.ts#L77)

Pub/Sub configuration (default: undefined/disabled)

***

### sanitization?

> `optional` **sanitization**: `false` \| [`SanitizationConfig`](SanitizationConfig.md)

Defined in: [packages/core/src/config.ts:89](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/config.ts#L89)

Signal sanitization configuration (default: enabled with standard redactions)
Set to false to disable sanitization

***

### signals?

> `optional` **signals**: `object`

Defined in: [packages/core/src/config.ts:92](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/config.ts#L92)

Custom signal configuration

#### adapters?

> `optional` **adapters**: [`SignalAdapter`](SignalAdapter.md)[]

Additional custom adapters

#### bus?

> `optional` **bus**: [`SignalBus`](../classes/SignalBus.md)

Shared signal bus instance
