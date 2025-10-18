# Interface: PlebOptions

Defined in: [smrt/packages/core/src/pleb.ts:10](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/pleb.ts#L10)

Configuration options for Pleb objects

 PlebOptions

## Extends

- [`SmrtObjectOptions`](SmrtObjectOptions.md)

## Indexable

\[`key`: `string`\]: `any`

Allow arbitrary field values to be passed

## Properties

### \_className?

> `optional` **\_className**: `string`

Defined in: [smrt/packages/core/src/class.ts:25](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/class.ts#L25)

Optional custom class name override

#### Inherited from

[`SmrtObjectOptions`](SmrtObjectOptions.md).[`_className`](SmrtObjectOptions.md#_classname)

***

### \_extractingFields?

> `optional` **\_extractingFields**: `boolean`

Defined in: [smrt/packages/core/src/object.ts:63](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L63)

Flag to skip automatic field extraction (internal use)

#### Inherited from

[`SmrtObjectOptions`](SmrtObjectOptions.md).[`_extractingFields`](SmrtObjectOptions.md#_extractingfields)

***

### \_skipLoad?

> `optional` **\_skipLoad**: `boolean`

Defined in: [smrt/packages/core/src/object.ts:68](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L68)

Flag to skip database loading (internal use)

#### Inherited from

[`SmrtObjectOptions`](SmrtObjectOptions.md).[`_skipLoad`](SmrtObjectOptions.md#_skipload)

***

### ai?

> `optional` **ai**: `AIClientOptions` \| `AIClient`

Defined in: [smrt/packages/core/src/class.ts:53](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/class.ts#L53)

AI client configuration options or instance

#### Inherited from

[`SmrtObjectOptions`](SmrtObjectOptions.md).[`ai`](SmrtObjectOptions.md#ai)

***

### context?

> `optional` **context**: `string`

Defined in: [smrt/packages/core/src/object.ts:48](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L48)

Optional context to scope the slug (could be a path, domain, etc.)

#### Inherited from

[`SmrtObjectOptions`](SmrtObjectOptions.md).[`context`](SmrtObjectOptions.md#context)

***

### created\_at?

> `optional` **created\_at**: `Date`

Defined in: [smrt/packages/core/src/object.ts:53](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L53)

Creation timestamp

#### Inherited from

[`SmrtObjectOptions`](SmrtObjectOptions.md).[`created_at`](SmrtObjectOptions.md#created_at)

***

### db?

> `optional` **db**: `string` \| \{\[`key`: `string`\]: `any`; `authToken?`: `string`; `type?`: `"sqlite"` \| `"postgres"`; `url?`: `string`; \} \| `DatabaseInterface`

Defined in: [smrt/packages/core/src/class.ts:35](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/class.ts#L35)

Database configuration - unified approach matching @have/sql

Supports three formats:
- String shortcut: 'products.db' (auto-detects database type)
- Config object: { type: 'sqlite', url: 'products.db' }
- DatabaseInterface instance: await getDatabase(...)

#### Inherited from

[`SmrtObjectOptions`](SmrtObjectOptions.md).[`db`](SmrtObjectOptions.md#db)

***

### fs?

> `optional` **fs**: `FilesystemAdapterOptions`

Defined in: [smrt/packages/core/src/class.ts:48](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/class.ts#L48)

Filesystem adapter configuration options

#### Inherited from

[`SmrtObjectOptions`](SmrtObjectOptions.md).[`fs`](SmrtObjectOptions.md#fs)

***

### id?

> `optional` **id**: `string`

Defined in: [smrt/packages/core/src/object.ts:33](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L33)

Unique identifier for the object

#### Inherited from

[`SmrtObjectOptions`](SmrtObjectOptions.md).[`id`](SmrtObjectOptions.md#id)

***

### logging?

> `optional` **logging**: `LoggerConfig`

Defined in: [smrt/packages/core/src/class.ts:58](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/class.ts#L58)

Logging configuration (overrides global default)

#### Inherited from

[`SmrtObjectOptions`](SmrtObjectOptions.md).[`logging`](SmrtObjectOptions.md#logging)

***

### metrics?

> `optional` **metrics**: [`MetricsConfig`](MetricsConfig.md)

Defined in: [smrt/packages/core/src/class.ts:63](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/class.ts#L63)

Metrics configuration (overrides global default)

#### Inherited from

[`SmrtObjectOptions`](SmrtObjectOptions.md).[`metrics`](SmrtObjectOptions.md#metrics)

***

### name?

> `optional` **name**: `string`

Defined in: [smrt/packages/core/src/object.ts:38](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L38)

Human-readable name for the object

#### Inherited from

[`SmrtObjectOptions`](SmrtObjectOptions.md).[`name`](SmrtObjectOptions.md#name)

***

### pubsub?

> `optional` **pubsub**: [`PubSubConfig`](PubSubConfig.md)

Defined in: [smrt/packages/core/src/class.ts:68](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/class.ts#L68)

Pub/Sub configuration (overrides global default)

#### Inherited from

[`SmrtObjectOptions`](SmrtObjectOptions.md).[`pubsub`](SmrtObjectOptions.md#pubsub)

***

### sanitization?

> `optional` **sanitization**: `false` \| [`SanitizationConfig`](SanitizationConfig.md)

Defined in: [smrt/packages/core/src/class.ts:73](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/class.ts#L73)

Sanitization configuration (overrides global default)

#### Inherited from

[`SmrtObjectOptions`](SmrtObjectOptions.md).[`sanitization`](SmrtObjectOptions.md#sanitization)

***

### signals?

> `optional` **signals**: `object`

Defined in: [smrt/packages/core/src/class.ts:78](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/class.ts#L78)

Custom signal configuration (overrides global default)

#### adapters?

> `optional` **adapters**: `SignalAdapter`[]

Additional custom adapters

#### bus?

> `optional` **bus**: [`SignalBus`](../classes/SignalBus.md)

Shared signal bus instance

#### Inherited from

[`SmrtObjectOptions`](SmrtObjectOptions.md).[`signals`](SmrtObjectOptions.md#signals)

***

### slug?

> `optional` **slug**: `string`

Defined in: [smrt/packages/core/src/object.ts:43](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L43)

URL-friendly identifier

#### Inherited from

[`SmrtObjectOptions`](SmrtObjectOptions.md).[`slug`](SmrtObjectOptions.md#slug)

***

### updated\_at?

> `optional` **updated\_at**: `Date`

Defined in: [smrt/packages/core/src/object.ts:58](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/object.ts#L58)

Last update timestamp

#### Inherited from

[`SmrtObjectOptions`](SmrtObjectOptions.md).[`updated_at`](SmrtObjectOptions.md#updated_at)
