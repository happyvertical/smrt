# Interface: SmrtCollectionOptions

Defined in: [smrt/packages/core/src/collection.ts:17](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/collection.ts#L17)

Configuration options for SmrtCollection

## Extends

- [`SmrtClassOptions`](SmrtClassOptions.md)

## Properties

### \_className?

> `optional` **\_className**: `string`

Defined in: [smrt/packages/core/src/class.ts:25](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/class.ts#L25)

Optional custom class name override

#### Inherited from

[`SmrtClassOptions`](SmrtClassOptions.md).[`_className`](SmrtClassOptions.md#_classname)

***

### ai?

> `optional` **ai**: `AIClientOptions` \| `AIClient`

Defined in: [smrt/packages/core/src/class.ts:53](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/class.ts#L53)

AI client configuration options or instance

#### Inherited from

[`SmrtClassOptions`](SmrtClassOptions.md).[`ai`](SmrtClassOptions.md#ai)

***

### db?

> `optional` **db**: `string` \| \{\[`key`: `string`\]: `any`; `authToken?`: `string`; `type?`: `"sqlite"` \| `"postgres"`; `url?`: `string`; \} \| `DatabaseInterface`

Defined in: [smrt/packages/core/src/class.ts:35](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/class.ts#L35)

Database configuration - unified approach matching @have/sql

Supports three formats:
- String shortcut: 'products.db' (auto-detects database type)
- Config object: { type: 'sqlite', url: 'products.db' }
- DatabaseInterface instance: await getDatabase(...)

#### Inherited from

[`SmrtClassOptions`](SmrtClassOptions.md).[`db`](SmrtClassOptions.md#db)

***

### fs?

> `optional` **fs**: `FilesystemAdapterOptions`

Defined in: [smrt/packages/core/src/class.ts:48](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/class.ts#L48)

Filesystem adapter configuration options

#### Inherited from

[`SmrtClassOptions`](SmrtClassOptions.md).[`fs`](SmrtClassOptions.md#fs)

***

### logging?

> `optional` **logging**: `LoggerConfig`

Defined in: [smrt/packages/core/src/class.ts:58](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/class.ts#L58)

Logging configuration (overrides global default)

#### Inherited from

[`SmrtClassOptions`](SmrtClassOptions.md).[`logging`](SmrtClassOptions.md#logging)

***

### metrics?

> `optional` **metrics**: [`MetricsConfig`](MetricsConfig.md)

Defined in: [smrt/packages/core/src/class.ts:63](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/class.ts#L63)

Metrics configuration (overrides global default)

#### Inherited from

[`SmrtClassOptions`](SmrtClassOptions.md).[`metrics`](SmrtClassOptions.md#metrics)

***

### pubsub?

> `optional` **pubsub**: [`PubSubConfig`](PubSubConfig.md)

Defined in: [smrt/packages/core/src/class.ts:68](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/class.ts#L68)

Pub/Sub configuration (overrides global default)

#### Inherited from

[`SmrtClassOptions`](SmrtClassOptions.md).[`pubsub`](SmrtClassOptions.md#pubsub)

***

### sanitization?

> `optional` **sanitization**: `false` \| [`SanitizationConfig`](SanitizationConfig.md)

Defined in: [smrt/packages/core/src/class.ts:73](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/class.ts#L73)

Sanitization configuration (overrides global default)

#### Inherited from

[`SmrtClassOptions`](SmrtClassOptions.md).[`sanitization`](SmrtClassOptions.md#sanitization)

***

### signals?

> `optional` **signals**: `object`

Defined in: [smrt/packages/core/src/class.ts:78](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/class.ts#L78)

Custom signal configuration (overrides global default)

#### adapters?

> `optional` **adapters**: `SignalAdapter`[]

Additional custom adapters

#### bus?

> `optional` **bus**: [`SignalBus`](../classes/SignalBus.md)

Shared signal bus instance

#### Inherited from

[`SmrtClassOptions`](SmrtClassOptions.md).[`signals`](SmrtClassOptions.md#signals)
