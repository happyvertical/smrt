# Interface: TagOptions

Defined in: tags/src/types.ts:10

Options for creating a Tag instance

## Extends

- `SmrtObjectOptions`

## Indexable

\[`key`: `string`\]: `any`

Allow arbitrary field values to be passed

## Properties

### \_className?

> `optional` **\_className**: `string`

Defined in: core/dist/class.d.ts:15

Optional custom class name override

#### Inherited from

`SmrtObjectOptions._className`

***

### \_extractingFields?

> `optional` **\_extractingFields**: `boolean`

Defined in: core/dist/object.d.ts:36

Flag to skip automatic field extraction (internal use)

#### Inherited from

`SmrtObjectOptions._extractingFields`

***

### \_skipLoad?

> `optional` **\_skipLoad**: `boolean`

Defined in: core/dist/object.d.ts:40

Flag to skip database loading (internal use)

#### Inherited from

`SmrtObjectOptions._skipLoad`

***

### ai?

> `optional` **ai**: `AIClient` \| `AIClientOptions`

Defined in: core/dist/class.d.ts:37

AI client configuration options or instance

#### Inherited from

`SmrtObjectOptions.ai`

***

### context?

> `optional` **context**: `string`

Defined in: tags/src/types.ts:13

Optional context to scope the slug (could be a path, domain, etc.)

#### Overrides

`SmrtObjectOptions.context`

***

### created\_at?

> `optional` **created\_at**: `Date`

Defined in: core/dist/object.d.ts:28

Creation timestamp

#### Inherited from

`SmrtObjectOptions.created_at`

***

### db?

> `optional` **db**: `string` \| `DatabaseInterface` \| \{\[`key`: `string`\]: `any`; `authToken?`: `string`; `type?`: `"sqlite"` \| `"postgres"`; `url?`: `string`; \}

Defined in: core/dist/class.d.ts:24

Database configuration - unified approach matching @have/sql

Supports three formats:
- String shortcut: 'products.db' (auto-detects database type)
- Config object: { type: 'sqlite', url: 'products.db' }
- DatabaseInterface instance: await getDatabase(...)

#### Inherited from

`SmrtObjectOptions.db`

***

### description?

> `optional` **description**: `string`

Defined in: tags/src/types.ts:16

***

### fs?

> `optional` **fs**: `FilesystemAdapterOptions`

Defined in: core/dist/class.d.ts:33

Filesystem adapter configuration options

#### Inherited from

`SmrtObjectOptions.fs`

***

### id?

> `optional` **id**: `string`

Defined in: core/dist/object.d.ts:12

Unique identifier for the object

#### Inherited from

`SmrtObjectOptions.id`

***

### level?

> `optional` **level**: `number`

Defined in: tags/src/types.ts:15

***

### logging?

> `optional` **logging**: `LoggerConfig`

Defined in: core/dist/class.d.ts:41

Logging configuration (overrides global default)

#### Inherited from

`SmrtObjectOptions.logging`

***

### metadata?

> `optional` **metadata**: `string` \| `Record`\<`string`, `any`\>

Defined in: tags/src/types.ts:17

***

### metrics?

> `optional` **metrics**: `MetricsConfig`

Defined in: core/dist/class.d.ts:45

Metrics configuration (overrides global default)

#### Inherited from

`SmrtObjectOptions.metrics`

***

### name?

> `optional` **name**: `string`

Defined in: tags/src/types.ts:12

Human-readable name for the object

#### Overrides

`SmrtObjectOptions.name`

***

### parentSlug?

> `optional` **parentSlug**: `string`

Defined in: tags/src/types.ts:14

***

### pubsub?

> `optional` **pubsub**: `PubSubConfig`

Defined in: core/dist/class.d.ts:49

Pub/Sub configuration (overrides global default)

#### Inherited from

`SmrtObjectOptions.pubsub`

***

### sanitization?

> `optional` **sanitization**: `false` \| `SanitizationConfig`

Defined in: core/dist/class.d.ts:53

Sanitization configuration (overrides global default)

#### Inherited from

`SmrtObjectOptions.sanitization`

***

### signals?

> `optional` **signals**: `object`

Defined in: core/dist/class.d.ts:57

Custom signal configuration (overrides global default)

#### adapters?

> `optional` **adapters**: `SignalAdapter`[]

Additional custom adapters

#### bus?

> `optional` **bus**: `SignalBus`

Shared signal bus instance

#### Inherited from

`SmrtObjectOptions.signals`

***

### slug?

> `optional` **slug**: `string`

Defined in: tags/src/types.ts:11

URL-friendly identifier

#### Overrides

`SmrtObjectOptions.slug`

***

### updated\_at?

> `optional` **updated\_at**: `Date`

Defined in: core/dist/object.d.ts:32

Last update timestamp

#### Inherited from

`SmrtObjectOptions.updated_at`
