# Interface: PlaceOptions

Defined in: [places/src/types.ts:27](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/places/src/types.ts#L27)

Options for creating/updating a Place

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

### city?

> `optional` **city**: `string`

Defined in: [places/src/types.ts:39](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/places/src/types.ts#L39)

***

### context?

> `optional` **context**: `string`

Defined in: core/dist/object.d.ts:19

Optional context to scope the slug (could be a path, domain, etc.)

#### Inherited from

`SmrtObjectOptions.context`

***

### country?

> `optional` **country**: `string`

Defined in: [places/src/types.ts:41](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/places/src/types.ts#L41)

***

### countryCode?

> `optional` **countryCode**: `string`

Defined in: [places/src/types.ts:43](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/places/src/types.ts#L43)

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

Defined in: [places/src/types.ts:52](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/places/src/types.ts#L52)

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

Defined in: [places/src/types.ts:32](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/places/src/types.ts#L32)

***

### externalId?

> `optional` **externalId**: `string`

Defined in: [places/src/types.ts:47](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/places/src/types.ts#L47)

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

Defined in: [places/src/types.ts:28](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/places/src/types.ts#L28)

Unique identifier for the object

#### Overrides

`SmrtObjectOptions.id`

***

### latitude?

> `optional` **latitude**: `number` \| `null`

Defined in: [places/src/types.ts:35](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/places/src/types.ts#L35)

***

### logging?

> `optional` **logging**: `LoggerConfig`

Defined in: core/dist/class.d.ts:52

Logging configuration (overrides global default)

#### Inherited from

`SmrtObjectOptions.logging`

***

### longitude?

> `optional` **longitude**: `number` \| `null`

Defined in: [places/src/types.ts:36](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/places/src/types.ts#L36)

***

### metadata?

> `optional` **metadata**: `string` \| `Record`\<`string`, `any`\>

Defined in: [places/src/types.ts:49](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/places/src/types.ts#L49)

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

Defined in: [places/src/types.ts:31](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/places/src/types.ts#L31)

***

### parentId?

> `optional` **parentId**: `string`

Defined in: [places/src/types.ts:30](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/places/src/types.ts#L30)

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

### postalCode?

> `optional` **postalCode**: `string`

Defined in: [places/src/types.ts:42](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/places/src/types.ts#L42)

***

### pubsub?

> `optional` **pubsub**: `PubSubConfig`

Defined in: core/dist/class.d.ts:60

Pub/Sub configuration (overrides global default)

#### Inherited from

`SmrtObjectOptions.pubsub`

***

### region?

> `optional` **region**: `string`

Defined in: [places/src/types.ts:40](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/places/src/types.ts#L40)

***

### sanitization?

> `optional` **sanitization**: `false` \| `SanitizationConfig`

Defined in: core/dist/class.d.ts:64

Sanitization configuration (overrides global default)

#### Inherited from

`SmrtObjectOptions.sanitization`

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

Defined in: core/dist/object.d.ts:15

URL-friendly identifier

#### Inherited from

`SmrtObjectOptions.slug`

***

### source?

> `optional` **source**: `string`

Defined in: [places/src/types.ts:48](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/places/src/types.ts#L48)

***

### streetName?

> `optional` **streetName**: `string`

Defined in: [places/src/types.ts:38](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/places/src/types.ts#L38)

***

### streetNumber?

> `optional` **streetNumber**: `string`

Defined in: [places/src/types.ts:37](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/places/src/types.ts#L37)

***

### timezone?

> `optional` **timezone**: `string`

Defined in: [places/src/types.ts:44](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/places/src/types.ts#L44)

***

### typeId?

> `optional` **typeId**: `string`

Defined in: [places/src/types.ts:29](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/places/src/types.ts#L29)

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

Defined in: [places/src/types.ts:53](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/places/src/types.ts#L53)
