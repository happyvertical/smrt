# Interface: ContentOptions

Defined in: content/src/content.ts:7

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

> `optional` **ai**: `AIClientOptions` \| `AIClient`

Defined in: core/dist/class.d.ts:37

AI client configuration options or instance

#### Inherited from

`SmrtObjectOptions.ai`

***

### author?

> `optional` **author**: `string` \| `null`

Defined in: content/src/content.ts:28

Author of the content

***

### body?

> `optional` **body**: `string` \| `null`

Defined in: content/src/content.ts:43

Main content body text

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

### db?

> `optional` **db**: `string` \| \{\[`key`: `string`\]: `any`; `authToken?`: `string`; `type?`: `"sqlite"` \| `"postgres"`; `url?`: `string`; \} \| `DatabaseInterface`

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

> `optional` **description**: `string` \| `null`

Defined in: content/src/content.ts:38

Short description or summary

***

### fileKey?

> `optional` **fileKey**: `string` \| `null`

Defined in: content/src/content.ts:23

Reference to file storage key

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

### language?

> `optional` **language**: `string` \| `null`

Defined in: content/src/content.ts:78

Content language

***

### logging?

> `optional` **logging**: `LoggerConfig`

Defined in: core/dist/class.d.ts:41

Logging configuration (overrides global default)

#### Inherited from

`SmrtObjectOptions.logging`

***

### metadata?

> `optional` **metadata**: `Record`\<`string`, `any`\>

Defined in: content/src/content.ts:88

Additional metadata

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

Defined in: core/dist/object.d.ts:16

Human-readable name for the object

#### Inherited from

`SmrtObjectOptions.name`

***

### original\_url?

> `optional` **original\_url**: `string` \| `null`

Defined in: content/src/content.ts:73

Original URL of the content

***

### publish\_date?

> `optional` **publish\_date**: `Date` \| `null`

Defined in: content/src/content.ts:48

Date when content was published

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

Defined in: core/dist/object.d.ts:20

URL-friendly identifier

#### Inherited from

`SmrtObjectOptions.slug`

***

### source?

> `optional` **source**: `string` \| `null`

Defined in: content/src/content.ts:58

Original source identifier

***

### state?

> `optional` **state**: `"deprecated"` \| `"active"` \| `"highlighted"` \| `null`

Defined in: content/src/content.ts:68

Content state flag

***

### status?

> `optional` **status**: `"published"` \| `"draft"` \| `"archived"` \| `"deleted"` \| `null`

Defined in: content/src/content.ts:63

Publication status

***

### tags?

> `optional` **tags**: `string`[]

Defined in: content/src/content.ts:83

Content tags

***

### title?

> `optional` **title**: `string` \| `null`

Defined in: content/src/content.ts:33

Content title

***

### type?

> `optional` **type**: `string` \| `null`

Defined in: content/src/content.ts:11

Content type classification

***

### updated\_at?

> `optional` **updated\_at**: `Date`

Defined in: core/dist/object.d.ts:32

Last update timestamp

#### Inherited from

`SmrtObjectOptions.updated_at`

***

### url?

> `optional` **url**: `string` \| `null`

Defined in: content/src/content.ts:53

URL source of the content

***

### variant?

> `optional` **variant**: `string` \| `null`

Defined in: content/src/content.ts:18

Content variant for namespaced classification within types
Format: generator:domain:specific-type
Example: "praeco:meeting:upcoming"
