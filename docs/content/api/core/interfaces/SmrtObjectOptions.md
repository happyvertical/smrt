# Interface: SmrtObjectOptions

Defined in: [packages/core/src/object.ts:25](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/object.ts#L25)

Options for SmrtObject initialization

## Extends

- [`SmrtClassOptions`](SmrtClassOptions.md)

## Indexable

\[`key`: `string`\]: `any`

Allow arbitrary field values to be passed

## Properties

### \_className?

> `optional` **\_className**: `string`

Defined in: [packages/core/src/class.ts:25](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L25)

Optional custom class name override

#### Inherited from

[`SmrtClassOptions`](SmrtClassOptions.md).[`_className`](SmrtClassOptions.md#_classname)

***

### \_extractingFields?

> `optional` **\_extractingFields**: `boolean`

Defined in: [packages/core/src/object.ts:54](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/object.ts#L54)

Flag to skip automatic field extraction (internal use)

***

### \_skipLoad?

> `optional` **\_skipLoad**: `boolean`

Defined in: [packages/core/src/object.ts:59](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/object.ts#L59)

Flag to skip database loading (internal use)

***

### ai?

> `optional` **ai**: `AIClientOptions` \| `AIClient`

Defined in: [packages/core/src/class.ts:68](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L68)

AI client configuration options or instance

#### Inherited from

[`SmrtClassOptions`](SmrtClassOptions.md).[`ai`](SmrtClassOptions.md#ai)

***

### context?

> `optional` **context**: `string`

Defined in: [packages/core/src/object.ts:39](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/object.ts#L39)

Optional context to scope the slug (could be a path, domain, etc.)

***

### created\_at?

> `optional` **created\_at**: `Date`

Defined in: [packages/core/src/object.ts:44](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/object.ts#L44)

Creation timestamp

***

### db?

> `optional` **db**: `string` \| \{\[`key`: `string`\]: `any`; `authToken?`: `string`; `type?`: `"sqlite"` \| `"postgres"` \| `"sql"`; `url?`: `string`; \} \| `DatabaseInterface`

Defined in: [packages/core/src/class.ts:35](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L35)

Database configuration - unified approach matching @happyvertical/sql

Supports three formats:
- String shortcut: 'products.db' (auto-detects database type)
- Config object: { type: 'sqlite', url: 'products.db' }
- DatabaseInterface instance: await getDatabase(...)

#### Inherited from

[`SmrtClassOptions`](SmrtClassOptions.md).[`db`](SmrtClassOptions.md#db)

***

### fs?

> `optional` **fs**: `FilesystemAdapterOptions`

Defined in: [packages/core/src/class.ts:63](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L63)

Filesystem adapter configuration options

#### Inherited from

[`SmrtClassOptions`](SmrtClassOptions.md).[`fs`](SmrtClassOptions.md#fs)

***

### id?

> `optional` **id**: `string`

Defined in: [packages/core/src/object.ts:29](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/object.ts#L29)

Unique identifier for the object

***

### logging?

> `optional` **logging**: `LoggerConfig`

Defined in: [packages/core/src/class.ts:73](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L73)

Logging configuration (overrides global default)

#### Inherited from

[`SmrtClassOptions`](SmrtClassOptions.md).[`logging`](SmrtClassOptions.md#logging)

***

### metrics?

> `optional` **metrics**: [`MetricsConfig`](MetricsConfig.md)

Defined in: [packages/core/src/class.ts:78](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L78)

Metrics configuration (overrides global default)

#### Inherited from

[`SmrtClassOptions`](SmrtClassOptions.md).[`metrics`](SmrtClassOptions.md#metrics)

***

### ~~persistence?~~

> `optional` **persistence**: `string` \| `DatabaseInterface` \| \{\[`key`: `string`\]: `any`; `authToken?`: `string`; `type?`: `"sqlite"` \| `"postgres"` \| `"sql"`; `url?`: `string`; \}

Defined in: [packages/core/src/class.ts:50](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L50)

Alias for db option - for backward compatibility with documentation

#### Deprecated

Use 'db' instead. This alias exists for backward compatibility.

#### Inherited from

[`SmrtClassOptions`](SmrtClassOptions.md).[`persistence`](SmrtClassOptions.md#persistence)

***

### pubsub?

> `optional` **pubsub**: [`PubSubConfig`](PubSubConfig.md)

Defined in: [packages/core/src/class.ts:83](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L83)

Pub/Sub configuration (overrides global default)

#### Inherited from

[`SmrtClassOptions`](SmrtClassOptions.md).[`pubsub`](SmrtClassOptions.md#pubsub)

***

### sanitization?

> `optional` **sanitization**: `false` \| [`SanitizationConfig`](SanitizationConfig.md)

Defined in: [packages/core/src/class.ts:88](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/class.ts#L88)

Sanitization configuration (overrides global default)

#### Inherited from

[`SmrtClassOptions`](SmrtClassOptions.md).[`sanitization`](SmrtClassOptions.md#sanitization)

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

#### Inherited from

[`SmrtClassOptions`](SmrtClassOptions.md).[`signals`](SmrtClassOptions.md#signals)

***

### slug?

> `optional` **slug**: `string`

Defined in: [packages/core/src/object.ts:34](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/object.ts#L34)

URL-friendly identifier

***

### updated\_at?

> `optional` **updated\_at**: `Date`

Defined in: [packages/core/src/object.ts:49](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/object.ts#L49)

Last update timestamp
