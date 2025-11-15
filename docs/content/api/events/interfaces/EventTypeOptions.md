# Interface: EventTypeOptions

Defined in: [events/src/types.ts:62](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/events/src/types.ts#L62)

Options for creating EventType

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

Defined in: core/dist/object.d.ts:31

Flag to skip automatic field extraction (internal use)

#### Inherited from

`SmrtObjectOptions._extractingFields`

***

### \_skipLoad?

> `optional` **\_skipLoad**: `boolean`

Defined in: core/dist/object.d.ts:35

Flag to skip database loading (internal use)

#### Inherited from

`SmrtObjectOptions._skipLoad`

***

### ai?

> `optional` **ai**: `AIClient` \| `AIClientOptions`

Defined in: core/dist/class.d.ts:48

AI client configuration options or instance

#### Inherited from

`SmrtObjectOptions.ai`

***

### context?

> `optional` **context**: `string`

Defined in: core/dist/object.d.ts:19

Optional context to scope the slug (could be a path, domain, etc.)

#### Inherited from

`SmrtObjectOptions.context`

***

### created\_at?

> `optional` **created\_at**: `Date`

Defined in: core/dist/object.d.ts:23

Creation timestamp

#### Inherited from

`SmrtObjectOptions.created_at`

***

### createdAt?

> `optional` **createdAt**: `Date`

Defined in: [events/src/types.ts:69](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/events/src/types.ts#L69)

***

### db?

> `optional` **db**: `string` \| `DatabaseInterface` \| \{\[`key`: `string`\]: `any`; `authToken?`: `string`; `type?`: `"sqlite"` \| `"postgres"` \| `"sql"`; `url?`: `string`; \}

Defined in: core/dist/class.d.ts:24

Database configuration - unified approach matching @happyvertical/sql

Supports three formats:
- String shortcut: 'products.db' (auto-detects database type)
- Config object: { type: 'sqlite', url: 'products.db' }
- DatabaseInterface instance: await getDatabase(...)

#### Inherited from

`SmrtObjectOptions.db`

***

### description?

> `optional` **description**: `string`

Defined in: [events/src/types.ts:66](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/events/src/types.ts#L66)

***

### fs?

> `optional` **fs**: `FilesystemAdapterOptions`

Defined in: core/dist/class.d.ts:44

Filesystem adapter configuration options

#### Inherited from

`SmrtObjectOptions.fs`

***

### id?

> `optional` **id**: `string`

Defined in: [events/src/types.ts:63](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/events/src/types.ts#L63)

Unique identifier for the object

#### Overrides

`SmrtObjectOptions.id`

***

### logging?

> `optional` **logging**: `LoggerConfig`

Defined in: core/dist/class.d.ts:52

Logging configuration (overrides global default)

#### Inherited from

`SmrtObjectOptions.logging`

***

### metrics?

> `optional` **metrics**: `MetricsConfig`

Defined in: core/dist/class.d.ts:56

Metrics configuration (overrides global default)

#### Inherited from

`SmrtObjectOptions.metrics`

***

### name?

> `optional` **name**: `string`

Defined in: [events/src/types.ts:65](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/events/src/types.ts#L65)

***

### participantSchema?

> `optional` **participantSchema**: `string` \| `Record`\<`string`, `any`\>

Defined in: [events/src/types.ts:68](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/events/src/types.ts#L68)

***

### ~~persistence?~~

> `optional` **persistence**: `string` \| `DatabaseInterface` \| \{\[`key`: `string`\]: `any`; `authToken?`: `string`; `type?`: `"sqlite"` \| `"postgres"` \| `"sql"`; `url?`: `string`; \}

Defined in: core/dist/class.d.ts:35

Alias for db option - for backward compatibility with documentation

#### Deprecated

Use 'db' instead. This alias exists for backward compatibility.

#### Inherited from

`SmrtObjectOptions.persistence`

***

### pubsub?

> `optional` **pubsub**: `PubSubConfig`

Defined in: core/dist/class.d.ts:60

Pub/Sub configuration (overrides global default)

#### Inherited from

`SmrtObjectOptions.pubsub`

***

### sanitization?

> `optional` **sanitization**: `false` \| `SanitizationConfig`

Defined in: core/dist/class.d.ts:64

Sanitization configuration (overrides global default)

#### Inherited from

`SmrtObjectOptions.sanitization`

***

### schema?

> `optional` **schema**: `string` \| `Record`\<`string`, `any`\>

Defined in: [events/src/types.ts:67](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/events/src/types.ts#L67)

***

### signals?

> `optional` **signals**: `object`

Defined in: core/dist/class.d.ts:68

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

Defined in: [events/src/types.ts:64](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/events/src/types.ts#L64)

URL-friendly identifier

#### Overrides

`SmrtObjectOptions.slug`

***

### updated\_at?

> `optional` **updated\_at**: `Date`

Defined in: core/dist/object.d.ts:27

Last update timestamp

#### Inherited from

`SmrtObjectOptions.updated_at`

***

### updatedAt?

> `optional` **updatedAt**: `Date`

Defined in: [events/src/types.ts:70](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/events/src/types.ts#L70)
