# Interface: EventOptions

Defined in: events/src/types.ts:96

Options for creating Event

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

Defined in: core/dist/object.d.ts:24

Optional context to scope the slug (could be a path, domain, etc.)

#### Inherited from

`SmrtObjectOptions.context`

***

### created\_at?

> `optional` **created\_at**: `Date`

Defined in: core/dist/object.d.ts:28

Creation timestamp

#### Inherited from

`SmrtObjectOptions.created_at`

***

### createdAt?

> `optional` **createdAt**: `Date`

Defined in: events/src/types.ts:112

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

Defined in: events/src/types.ts:104

***

### endDate?

> `optional` **endDate**: `Date` \| `null`

Defined in: events/src/types.ts:106

***

### externalId?

> `optional` **externalId**: `string`

Defined in: events/src/types.ts:110

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

Defined in: events/src/types.ts:97

Unique identifier for the object

#### Overrides

`SmrtObjectOptions.id`

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

Defined in: events/src/types.ts:109

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

Defined in: events/src/types.ts:102

Human-readable name for the object

#### Overrides

`SmrtObjectOptions.name`

***

### parentEventId?

> `optional` **parentEventId**: `string`

Defined in: events/src/types.ts:99

***

### placeId?

> `optional` **placeId**: `string`

Defined in: events/src/types.ts:101

***

### pubsub?

> `optional` **pubsub**: `PubSubConfig`

Defined in: core/dist/class.d.ts:49

Pub/Sub configuration (overrides global default)

#### Inherited from

`SmrtObjectOptions.pubsub`

***

### round?

> `optional` **round**: `number` \| `null`

Defined in: events/src/types.ts:108

***

### sanitization?

> `optional` **sanitization**: `false` \| `SanitizationConfig`

Defined in: core/dist/class.d.ts:53

Sanitization configuration (overrides global default)

#### Inherited from

`SmrtObjectOptions.sanitization`

***

### seriesId?

> `optional` **seriesId**: `string`

Defined in: events/src/types.ts:98

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

Defined in: events/src/types.ts:103

URL-friendly identifier

#### Overrides

`SmrtObjectOptions.slug`

***

### source?

> `optional` **source**: `string`

Defined in: events/src/types.ts:111

***

### startDate?

> `optional` **startDate**: `Date` \| `null`

Defined in: events/src/types.ts:105

***

### status?

> `optional` **status**: [`EventStatus`](../type-aliases/EventStatus.md)

Defined in: events/src/types.ts:107

***

### typeId?

> `optional` **typeId**: `string`

Defined in: events/src/types.ts:100

***

### updated\_at?

> `optional` **updated\_at**: `Date`

Defined in: core/dist/object.d.ts:32

Last update timestamp

#### Inherited from

`SmrtObjectOptions.updated_at`

***

### updatedAt?

> `optional` **updatedAt**: `Date`

Defined in: events/src/types.ts:113
