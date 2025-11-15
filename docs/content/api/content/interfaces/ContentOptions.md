# Interface: ContentOptions

Defined in: [content/src/content.ts:8](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/content/src/content.ts#L8)

Options for Content initialization

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

> `optional` **ai**: `AIClientOptions` \| `AIClient`

Defined in: core/dist/class.d.ts:48

AI client configuration options or instance

#### Inherited from

`SmrtObjectOptions.ai`

***

### author?

> `optional` **author**: `string` \| `null`

Defined in: [content/src/content.ts:29](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/content/src/content.ts#L29)

Author of the content

***

### body?

> `optional` **body**: `string` \| `null`

Defined in: [content/src/content.ts:44](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/content/src/content.ts#L44)

Main content body text

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

### db?

> `optional` **db**: `string` \| \{\[`key`: `string`\]: `any`; `authToken?`: `string`; `type?`: `"sqlite"` \| `"postgres"` \| `"sql"`; `url?`: `string`; \} \| `DatabaseInterface`

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

> `optional` **description**: `string` \| `null`

Defined in: [content/src/content.ts:39](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/content/src/content.ts#L39)

Short description or summary

***

### fileKey?

> `optional` **fileKey**: `string` \| `null`

Defined in: [content/src/content.ts:24](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/content/src/content.ts#L24)

Reference to file storage key

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

Defined in: core/dist/object.d.ts:11

Unique identifier for the object

#### Inherited from

`SmrtObjectOptions.id`

***

### language?

> `optional` **language**: `string` \| `null`

Defined in: [content/src/content.ts:79](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/content/src/content.ts#L79)

Content language

***

### logging?

> `optional` **logging**: `LoggerConfig`

Defined in: core/dist/class.d.ts:52

Logging configuration (overrides global default)

#### Inherited from

`SmrtObjectOptions.logging`

***

### metadata?

> `optional` **metadata**: `Record`\<`string`, `any`\>

Defined in: [content/src/content.ts:89](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/content/src/content.ts#L89)

Additional metadata

***

### metrics?

> `optional` **metrics**: `MetricsConfig`

Defined in: core/dist/class.d.ts:56

Metrics configuration (overrides global default)

#### Inherited from

`SmrtObjectOptions.metrics`

***

### original\_url?

> `optional` **original\_url**: `string` \| `null`

Defined in: [content/src/content.ts:74](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/content/src/content.ts#L74)

Original URL of the content

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

### publish\_date?

> `optional` **publish\_date**: `Date` \| `null`

Defined in: [content/src/content.ts:49](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/content/src/content.ts#L49)

Date when content was published

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

> `optional` **source**: `string` \| `null`

Defined in: [content/src/content.ts:59](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/content/src/content.ts#L59)

Original source identifier

***

### state?

> `optional` **state**: `"deprecated"` \| `"active"` \| `"highlighted"` \| `null`

Defined in: [content/src/content.ts:69](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/content/src/content.ts#L69)

Content state flag

***

### status?

> `optional` **status**: `"published"` \| `"draft"` \| `"archived"` \| `"deleted"` \| `null`

Defined in: [content/src/content.ts:64](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/content/src/content.ts#L64)

Publication status

***

### tags?

> `optional` **tags**: `string`[]

Defined in: [content/src/content.ts:84](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/content/src/content.ts#L84)

Content tags

***

### title?

> `optional` **title**: `string` \| `null`

Defined in: [content/src/content.ts:34](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/content/src/content.ts#L34)

Content title

***

### type?

> `optional` **type**: `string` \| `null`

Defined in: [content/src/content.ts:12](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/content/src/content.ts#L12)

Content type classification

***

### updated\_at?

> `optional` **updated\_at**: `Date`

Defined in: core/dist/object.d.ts:27

Last update timestamp

#### Inherited from

`SmrtObjectOptions.updated_at`

***

### url?

> `optional` **url**: `string` \| `null`

Defined in: [content/src/content.ts:54](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/content/src/content.ts#L54)

URL source of the content

***

### variant?

> `optional` **variant**: `string` \| `null`

Defined in: [content/src/content.ts:19](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/content/src/content.ts#L19)

Content variant for namespaced classification within types
Format: generator:domain:specific-type
Example: "praeco:meeting:upcoming"
