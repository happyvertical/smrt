# Interface: ContentsOptions

Defined in: content/src/contents.ts:15

Configuration options for Contents collection

## Extends

- `SmrtCollectionOptions`

## Properties

### \_className?

> `optional` **\_className**: `string`

Defined in: core/dist/class.d.ts:15

Optional custom class name override

#### Inherited from

`SmrtCollectionOptions._className`

***

### ai?

> `optional` **ai**: `AIClientOptions`

Defined in: content/src/contents.ts:19

AI client configuration options

#### Overrides

`SmrtCollectionOptions.ai`

***

### contentDir?

> `optional` **contentDir**: `string`

Defined in: content/src/contents.ts:24

Directory to store content files

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

`SmrtCollectionOptions.db`

***

### fs?

> `optional` **fs**: `FilesystemAdapterOptions`

Defined in: core/dist/class.d.ts:33

Filesystem adapter configuration options

#### Inherited from

`SmrtCollectionOptions.fs`

***

### logging?

> `optional` **logging**: `LoggerConfig`

Defined in: core/dist/class.d.ts:41

Logging configuration (overrides global default)

#### Inherited from

`SmrtCollectionOptions.logging`

***

### metrics?

> `optional` **metrics**: `MetricsConfig`

Defined in: core/dist/class.d.ts:45

Metrics configuration (overrides global default)

#### Inherited from

`SmrtCollectionOptions.metrics`

***

### pubsub?

> `optional` **pubsub**: `PubSubConfig`

Defined in: core/dist/class.d.ts:49

Pub/Sub configuration (overrides global default)

#### Inherited from

`SmrtCollectionOptions.pubsub`

***

### sanitization?

> `optional` **sanitization**: `false` \| `SanitizationConfig`

Defined in: core/dist/class.d.ts:53

Sanitization configuration (overrides global default)

#### Inherited from

`SmrtCollectionOptions.sanitization`

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

`SmrtCollectionOptions.signals`
