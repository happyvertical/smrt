# Interface: SmrtObjectOptions

Defined in: smrt/packages/core/src/object.ts:29

Options for SmrtObject initialization

## Extends

- [`SmrtClassOptions`](SmrtClassOptions.md)

## Extended by

- [`PlebOptions`](PlebOptions.md)

## Indexable

\[`key`: `string`\]: `any`

Allow arbitrary field values to be passed

## Properties

### \_className?

> `optional` **\_className**: `string`

Defined in: smrt/packages/core/src/class.ts:25

Optional custom class name override

#### Inherited from

[`SmrtClassOptions`](SmrtClassOptions.md).[`_className`](SmrtClassOptions.md#_classname)

***

### \_extractingFields?

> `optional` **\_extractingFields**: `boolean`

Defined in: smrt/packages/core/src/object.ts:63

Flag to skip automatic field extraction (internal use)

***

### \_skipLoad?

> `optional` **\_skipLoad**: `boolean`

Defined in: smrt/packages/core/src/object.ts:68

Flag to skip database loading (internal use)

***

### ai?

> `optional` **ai**: `AIClientOptions` \| `AIClient`

Defined in: smrt/packages/core/src/class.ts:53

AI client configuration options or instance

#### Inherited from

[`SmrtClassOptions`](SmrtClassOptions.md).[`ai`](SmrtClassOptions.md#ai)

***

### context?

> `optional` **context**: `string`

Defined in: smrt/packages/core/src/object.ts:48

Optional context to scope the slug (could be a path, domain, etc.)

***

### created\_at?

> `optional` **created\_at**: `Date`

Defined in: smrt/packages/core/src/object.ts:53

Creation timestamp

***

### db?

> `optional` **db**: `string` \| \{\[`key`: `string`\]: `any`; `authToken?`: `string`; `type?`: `"sqlite"` \| `"postgres"`; `url?`: `string`; \} \| `DatabaseInterface`

Defined in: smrt/packages/core/src/class.ts:35

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

Defined in: smrt/packages/core/src/class.ts:48

Filesystem adapter configuration options

#### Inherited from

[`SmrtClassOptions`](SmrtClassOptions.md).[`fs`](SmrtClassOptions.md#fs)

***

### id?

> `optional` **id**: `string`

Defined in: smrt/packages/core/src/object.ts:33

Unique identifier for the object

***

### logging?

> `optional` **logging**: `LoggerConfig`

Defined in: smrt/packages/core/src/class.ts:58

Logging configuration (overrides global default)

#### Inherited from

[`SmrtClassOptions`](SmrtClassOptions.md).[`logging`](SmrtClassOptions.md#logging)

***

### metrics?

> `optional` **metrics**: [`MetricsConfig`](MetricsConfig.md)

Defined in: smrt/packages/core/src/class.ts:63

Metrics configuration (overrides global default)

#### Inherited from

[`SmrtClassOptions`](SmrtClassOptions.md).[`metrics`](SmrtClassOptions.md#metrics)

***

### name?

> `optional` **name**: `string`

Defined in: smrt/packages/core/src/object.ts:38

Human-readable name for the object

***

### pubsub?

> `optional` **pubsub**: [`PubSubConfig`](PubSubConfig.md)

Defined in: smrt/packages/core/src/class.ts:68

Pub/Sub configuration (overrides global default)

#### Inherited from

[`SmrtClassOptions`](SmrtClassOptions.md).[`pubsub`](SmrtClassOptions.md#pubsub)

***

### sanitization?

> `optional` **sanitization**: `false` \| [`SanitizationConfig`](SanitizationConfig.md)

Defined in: smrt/packages/core/src/class.ts:73

Sanitization configuration (overrides global default)

#### Inherited from

[`SmrtClassOptions`](SmrtClassOptions.md).[`sanitization`](SmrtClassOptions.md#sanitization)

***

### signals?

> `optional` **signals**: `object`

Defined in: smrt/packages/core/src/class.ts:78

Custom signal configuration (overrides global default)

#### adapters?

> `optional` **adapters**: `SignalAdapter`[]

Additional custom adapters

#### bus?

> `optional` **bus**: [`SignalBus`](../classes/SignalBus.md)

Shared signal bus instance

#### Inherited from

[`SmrtClassOptions`](SmrtClassOptions.md).[`signals`](SmrtClassOptions.md#signals)

***

### slug?

> `optional` **slug**: `string`

Defined in: smrt/packages/core/src/object.ts:43

URL-friendly identifier

***

### updated\_at?

> `optional` **updated\_at**: `Date`

Defined in: smrt/packages/core/src/object.ts:58

Last update timestamp
