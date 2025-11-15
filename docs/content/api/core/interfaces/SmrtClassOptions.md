# Interface: SmrtClassOptions

Defined in: [packages/core/src/class.ts:21](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L21)

Configuration options for the SmrtClass

## Extended by

- [`SmrtCollectionOptions`](SmrtCollectionOptions.md)
- [`SmrtObjectOptions`](SmrtObjectOptions.md)

## Properties

### \_className?

> `optional` **\_className**: `string`

Defined in: [packages/core/src/class.ts:25](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L25)

Optional custom class name override

***

### ai?

> `optional` **ai**: `AIClientOptions` \| `AIClient`

Defined in: [packages/core/src/class.ts:68](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L68)

AI client configuration options or instance

***

### db?

> `optional` **db**: `string` \| \{\[`key`: `string`\]: `any`; `authToken?`: `string`; `type?`: `"sqlite"` \| `"postgres"` \| `"sql"`; `url?`: `string`; \} \| `DatabaseInterface`

Defined in: [packages/core/src/class.ts:35](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L35)

Database configuration - unified approach matching @happyvertical/sql

Supports three formats:
- String shortcut: 'products.db' (auto-detects database type)
- Config object: { type: 'sqlite', url: 'products.db' }
- DatabaseInterface instance: await getDatabase(...)

***

### fs?

> `optional` **fs**: `FilesystemAdapterOptions`

Defined in: [packages/core/src/class.ts:63](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L63)

Filesystem adapter configuration options

***

### logging?

> `optional` **logging**: `LoggerConfig`

Defined in: [packages/core/src/class.ts:73](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L73)

Logging configuration (overrides global default)

***

### metrics?

> `optional` **metrics**: [`MetricsConfig`](MetricsConfig.md)

Defined in: [packages/core/src/class.ts:78](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L78)

Metrics configuration (overrides global default)

***

### ~~persistence?~~

> `optional` **persistence**: `string` \| `DatabaseInterface` \| \{\[`key`: `string`\]: `any`; `authToken?`: `string`; `type?`: `"sqlite"` \| `"postgres"` \| `"sql"`; `url?`: `string`; \}

Defined in: [packages/core/src/class.ts:50](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L50)

Alias for db option - for backward compatibility with documentation

#### Deprecated

Use 'db' instead. This alias exists for backward compatibility.

***

### pubsub?

> `optional` **pubsub**: [`PubSubConfig`](PubSubConfig.md)

Defined in: [packages/core/src/class.ts:83](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L83)

Pub/Sub configuration (overrides global default)

***

### sanitization?

> `optional` **sanitization**: `false` \| [`SanitizationConfig`](SanitizationConfig.md)

Defined in: [packages/core/src/class.ts:88](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L88)

Sanitization configuration (overrides global default)

***

### signals?

> `optional` **signals**: `object`

Defined in: [packages/core/src/class.ts:93](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L93)

Custom signal configuration (overrides global default)

#### adapters?

> `optional` **adapters**: [`SignalAdapter`](SignalAdapter.md)[]

Additional custom adapters

#### bus?

> `optional` **bus**: [`SignalBus`](../classes/SignalBus.md)

Shared signal bus instance
