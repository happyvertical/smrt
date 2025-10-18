# Interface: ContentOptions

Defined in: [content/src/content.ts:7](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/content/src/content.ts#L7)

Options for Content initialization

## Extends

- `SmrtObjectOptions`

## Indexable

\[`key`: `string`\]: `any`

Allow arbitrary field values to be passed

## Properties

### \_className?

> `optional` **\_className**: `string`

Defined in: [core/dist/class.d.ts:15](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/class.d.ts#L15)

Optional custom class name override

#### Inherited from

`SmrtObjectOptions._className`

***

### \_extractingFields?

> `optional` **\_extractingFields**: `boolean`

Defined in: [core/dist/object.d.ts:36](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L36)

Flag to skip automatic field extraction (internal use)

#### Inherited from

`SmrtObjectOptions._extractingFields`

***

### \_skipLoad?

> `optional` **\_skipLoad**: `boolean`

Defined in: [core/dist/object.d.ts:40](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L40)

Flag to skip database loading (internal use)

#### Inherited from

`SmrtObjectOptions._skipLoad`

***

### ai?

> `optional` **ai**: `AIClientOptions` \| `AIClient`

Defined in: [core/dist/class.d.ts:37](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/class.d.ts#L37)

AI client configuration options or instance

#### Inherited from

`SmrtObjectOptions.ai`

***

### author?

> `optional` **author**: `string` \| `null`

Defined in: [content/src/content.ts:28](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/content/src/content.ts#L28)

Author of the content

***

### body?

> `optional` **body**: `string` \| `null`

Defined in: [content/src/content.ts:43](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/content/src/content.ts#L43)

Main content body text

***

### context?

> `optional` **context**: `string`

Defined in: [core/dist/object.d.ts:24](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L24)

Optional context to scope the slug (could be a path, domain, etc.)

#### Inherited from

`SmrtObjectOptions.context`

***

### created\_at?

> `optional` **created\_at**: `Date`

Defined in: [core/dist/object.d.ts:28](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L28)

Creation timestamp

#### Inherited from

`SmrtObjectOptions.created_at`

***

### db?

> `optional` **db**: `string` \| \{\[`key`: `string`\]: `any`; `authToken?`: `string`; `type?`: `"sqlite"` \| `"postgres"`; `url?`: `string`; \} \| `DatabaseInterface`

Defined in: [core/dist/class.d.ts:24](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/class.d.ts#L24)

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

Defined in: [content/src/content.ts:38](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/content/src/content.ts#L38)

Short description or summary

***

### fileKey?

> `optional` **fileKey**: `string` \| `null`

Defined in: [content/src/content.ts:23](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/content/src/content.ts#L23)

Reference to file storage key

***

### fs?

> `optional` **fs**: `FilesystemAdapterOptions`

Defined in: [core/dist/class.d.ts:33](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/class.d.ts#L33)

Filesystem adapter configuration options

#### Inherited from

`SmrtObjectOptions.fs`

***

### id?

> `optional` **id**: `string`

Defined in: [core/dist/object.d.ts:12](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L12)

Unique identifier for the object

#### Inherited from

`SmrtObjectOptions.id`

***

### language?

> `optional` **language**: `string` \| `null`

Defined in: [content/src/content.ts:78](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/content/src/content.ts#L78)

Content language

***

### logging?

> `optional` **logging**: `LoggerConfig`

Defined in: [core/dist/class.d.ts:41](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/class.d.ts#L41)

Logging configuration (overrides global default)

#### Inherited from

`SmrtObjectOptions.logging`

***

### metadata?

> `optional` **metadata**: `Record`\<`string`, `any`\>

Defined in: [content/src/content.ts:88](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/content/src/content.ts#L88)

Additional metadata

***

### metrics?

> `optional` **metrics**: `MetricsConfig`

Defined in: [core/dist/class.d.ts:45](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/class.d.ts#L45)

Metrics configuration (overrides global default)

#### Inherited from

`SmrtObjectOptions.metrics`

***

### name?

> `optional` **name**: `string`

Defined in: [core/dist/object.d.ts:16](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L16)

Human-readable name for the object

#### Inherited from

`SmrtObjectOptions.name`

***

### original\_url?

> `optional` **original\_url**: `string` \| `null`

Defined in: [content/src/content.ts:73](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/content/src/content.ts#L73)

Original URL of the content

***

### publish\_date?

> `optional` **publish\_date**: `Date` \| `null`

Defined in: [content/src/content.ts:48](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/content/src/content.ts#L48)

Date when content was published

***

### pubsub?

> `optional` **pubsub**: `PubSubConfig`

Defined in: [core/dist/class.d.ts:49](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/class.d.ts#L49)

Pub/Sub configuration (overrides global default)

#### Inherited from

`SmrtObjectOptions.pubsub`

***

### sanitization?

> `optional` **sanitization**: `false` \| `SanitizationConfig`

Defined in: [core/dist/class.d.ts:53](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/class.d.ts#L53)

Sanitization configuration (overrides global default)

#### Inherited from

`SmrtObjectOptions.sanitization`

***

### signals?

> `optional` **signals**: `object`

Defined in: [core/dist/class.d.ts:57](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/class.d.ts#L57)

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

Defined in: [core/dist/object.d.ts:20](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L20)

URL-friendly identifier

#### Inherited from

`SmrtObjectOptions.slug`

***

### source?

> `optional` **source**: `string` \| `null`

Defined in: [content/src/content.ts:58](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/content/src/content.ts#L58)

Original source identifier

***

### state?

> `optional` **state**: `"deprecated"` \| `"active"` \| `"highlighted"` \| `null`

Defined in: [content/src/content.ts:68](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/content/src/content.ts#L68)

Content state flag

***

### status?

> `optional` **status**: `"published"` \| `"draft"` \| `"archived"` \| `"deleted"` \| `null`

Defined in: [content/src/content.ts:63](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/content/src/content.ts#L63)

Publication status

***

### tags?

> `optional` **tags**: `string`[]

Defined in: [content/src/content.ts:83](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/content/src/content.ts#L83)

Content tags

***

### title?

> `optional` **title**: `string` \| `null`

Defined in: [content/src/content.ts:33](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/content/src/content.ts#L33)

Content title

***

### type?

> `optional` **type**: `string` \| `null`

Defined in: [content/src/content.ts:11](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/content/src/content.ts#L11)

Content type classification

***

### updated\_at?

> `optional` **updated\_at**: `Date`

Defined in: [core/dist/object.d.ts:32](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L32)

Last update timestamp

#### Inherited from

`SmrtObjectOptions.updated_at`

***

### url?

> `optional` **url**: `string` \| `null`

Defined in: [content/src/content.ts:53](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/content/src/content.ts#L53)

URL source of the content

***

### variant?

> `optional` **variant**: `string` \| `null`

Defined in: [content/src/content.ts:18](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/content/src/content.ts#L18)

Content variant for namespaced classification within types
Format: generator:domain:specific-type
Example: "praeco:meeting:upcoming"
