# Interface: EventParticipantOptions

Defined in: [events/src/types.ts:119](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/events/src/types.ts#L119)

Options for creating EventParticipant

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

> `optional` **ai**: `AIClient` \| `AIClientOptions`

Defined in: [core/dist/class.d.ts:37](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/class.d.ts#L37)

AI client configuration options or instance

#### Inherited from

`SmrtObjectOptions.ai`

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

### createdAt?

> `optional` **createdAt**: `Date`

Defined in: [events/src/types.ts:129](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/events/src/types.ts#L129)

***

### db?

> `optional` **db**: `string` \| `DatabaseInterface` \| \{\[`key`: `string`\]: `any`; `authToken?`: `string`; `type?`: `"sqlite"` \| `"postgres"`; `url?`: `string`; \}

Defined in: [core/dist/class.d.ts:24](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/class.d.ts#L24)

Database configuration - unified approach matching @have/sql

Supports three formats:
- String shortcut: 'products.db' (auto-detects database type)
- Config object: { type: 'sqlite', url: 'products.db' }
- DatabaseInterface instance: await getDatabase(...)

#### Inherited from

`SmrtObjectOptions.db`

***

### eventId?

> `optional` **eventId**: `string`

Defined in: [events/src/types.ts:121](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/events/src/types.ts#L121)

***

### externalId?

> `optional` **externalId**: `string`

Defined in: [events/src/types.ts:127](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/events/src/types.ts#L127)

***

### fs?

> `optional` **fs**: `FilesystemAdapterOptions`

Defined in: [core/dist/class.d.ts:33](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/class.d.ts#L33)

Filesystem adapter configuration options

#### Inherited from

`SmrtObjectOptions.fs`

***

### groupId?

> `optional` **groupId**: `string`

Defined in: [events/src/types.ts:125](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/events/src/types.ts#L125)

***

### id?

> `optional` **id**: `string`

Defined in: [events/src/types.ts:120](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/events/src/types.ts#L120)

Unique identifier for the object

#### Overrides

`SmrtObjectOptions.id`

***

### logging?

> `optional` **logging**: `LoggerConfig`

Defined in: [core/dist/class.d.ts:41](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/class.d.ts#L41)

Logging configuration (overrides global default)

#### Inherited from

`SmrtObjectOptions.logging`

***

### metadata?

> `optional` **metadata**: `string` \| `Record`\<`string`, `any`\>

Defined in: [events/src/types.ts:126](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/events/src/types.ts#L126)

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

### placement?

> `optional` **placement**: `number` \| `null`

Defined in: [events/src/types.ts:124](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/events/src/types.ts#L124)

***

### profileId?

> `optional` **profileId**: `string`

Defined in: [events/src/types.ts:122](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/events/src/types.ts#L122)

***

### pubsub?

> `optional` **pubsub**: `PubSubConfig`

Defined in: [core/dist/class.d.ts:49](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/class.d.ts#L49)

Pub/Sub configuration (overrides global default)

#### Inherited from

`SmrtObjectOptions.pubsub`

***

### role?

> `optional` **role**: `string`

Defined in: [events/src/types.ts:123](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/events/src/types.ts#L123)

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

> `optional` **source**: `string`

Defined in: [events/src/types.ts:128](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/events/src/types.ts#L128)

***

### updated\_at?

> `optional` **updated\_at**: `Date`

Defined in: [core/dist/object.d.ts:32](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/dist/object.d.ts#L32)

Last update timestamp

#### Inherited from

`SmrtObjectOptions.updated_at`

***

### updatedAt?

> `optional` **updatedAt**: `Date`

Defined in: [events/src/types.ts:130](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/events/src/types.ts#L130)
