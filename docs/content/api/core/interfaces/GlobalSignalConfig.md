# Interface: GlobalSignalConfig

Defined in: [smrt/packages/core/src/config.ts:38](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/config.ts#L38)

Global signal configuration

Application-level defaults for signal adapters.
These can be overridden per-instance via SmrtClassOptions.

## Properties

### logging?

> `optional` **logging**: `LoggerConfig`

Defined in: [smrt/packages/core/src/config.ts:40](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/config.ts#L40)

Logging configuration (default: true with console, info level)

***

### metrics?

> `optional` **metrics**: [`MetricsConfig`](MetricsConfig.md)

Defined in: [smrt/packages/core/src/config.ts:43](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/config.ts#L43)

Metrics configuration (default: undefined/disabled)

***

### pubsub?

> `optional` **pubsub**: [`PubSubConfig`](PubSubConfig.md)

Defined in: [smrt/packages/core/src/config.ts:46](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/config.ts#L46)

Pub/Sub configuration (default: undefined/disabled)

***

### sanitization?

> `optional` **sanitization**: `false` \| [`SanitizationConfig`](SanitizationConfig.md)

Defined in: [smrt/packages/core/src/config.ts:52](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/config.ts#L52)

Signal sanitization configuration (default: enabled with standard redactions)
Set to false to disable sanitization

***

### signals?

> `optional` **signals**: `object`

Defined in: [smrt/packages/core/src/config.ts:55](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/config.ts#L55)

Custom signal configuration

#### adapters?

> `optional` **adapters**: `SignalAdapter`[]

Additional custom adapters

#### bus?

> `optional` **bus**: [`SignalBus`](../classes/SignalBus.md)

Shared signal bus instance
