# Class: ManifestGenerator

Defined in: [smrt/packages/core/src/scanner/manifest-generator.ts:12](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/scanner/manifest-generator.ts#L12)

Static manifest module for runtime use
Uses pre-generated manifest from build time instead of runtime scanning

## Constructors

### Constructor

> **new ManifestGenerator**(): `ManifestGenerator`

#### Returns

`ManifestGenerator`

## Methods

### generateManifest()

> **generateManifest**(`scanResults`): [`SmartObjectManifest`](../interfaces/SmartObjectManifest.md)

Defined in: [smrt/packages/core/src/scanner/manifest-generator.ts:16](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/scanner/manifest-generator.ts#L16)

Generate manifest from scan results

#### Parameters

##### scanResults

`ScanResult`[]

#### Returns

[`SmartObjectManifest`](../interfaces/SmartObjectManifest.md)

***

### generateMCPTools()

> **generateMCPTools**(`manifest`): `string`

Defined in: [smrt/packages/core/src/scanner/manifest-generator.ts:271](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/scanner/manifest-generator.ts#L271)

Generate simple MCP tool names for testing/documentation

#### Parameters

##### manifest

[`SmartObjectManifest`](../interfaces/SmartObjectManifest.md)

#### Returns

`string`

***

### generateMCPToolsCode()

> **generateMCPToolsCode**(`manifest`): `string`

Defined in: [smrt/packages/core/src/scanner/manifest-generator.ts:287](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/scanner/manifest-generator.ts#L287)

Generate MCP tool JSON definitions

#### Parameters

##### manifest

[`SmartObjectManifest`](../interfaces/SmartObjectManifest.md)

#### Returns

`string`

***

### generateRestEndpointCode()

> **generateRestEndpointCode**(`manifest`): `string`

Defined in: [smrt/packages/core/src/scanner/manifest-generator.ts:119](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/scanner/manifest-generator.ts#L119)

Generate REST endpoint code implementations

#### Parameters

##### manifest

[`SmartObjectManifest`](../interfaces/SmartObjectManifest.md)

#### Returns

`string`

***

### generateRestEndpoints()

> **generateRestEndpoints**(`manifest`): `string`

Defined in: [smrt/packages/core/src/scanner/manifest-generator.ts:103](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/scanner/manifest-generator.ts#L103)

Generate simple endpoint list for testing/documentation

#### Parameters

##### manifest

[`SmartObjectManifest`](../interfaces/SmartObjectManifest.md)

#### Returns

`string`

***

### generateTypeDefinitions()

> **generateTypeDefinitions**(`manifest`): `string`

Defined in: [smrt/packages/core/src/scanner/manifest-generator.ts:49](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/scanner/manifest-generator.ts#L49)

Generate TypeScript interfaces from manifest

#### Parameters

##### manifest

[`SmartObjectManifest`](../interfaces/SmartObjectManifest.md)

#### Returns

`string`

***

### loadManifest()

> **loadManifest**(`filePath`): [`SmartObjectManifest`](../interfaces/SmartObjectManifest.md)

Defined in: [smrt/packages/core/src/scanner/manifest-generator.ts:463](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/scanner/manifest-generator.ts#L463)

Load manifest from file

#### Parameters

##### filePath

`string`

#### Returns

[`SmartObjectManifest`](../interfaces/SmartObjectManifest.md)

***

### saveManifest()

> **saveManifest**(`manifest`, `filePath`): `void`

Defined in: [smrt/packages/core/src/scanner/manifest-generator.ts:455](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/scanner/manifest-generator.ts#L455)

Save manifest to file

#### Parameters

##### manifest

[`SmartObjectManifest`](../interfaces/SmartObjectManifest.md)

##### filePath

`string`

#### Returns

`void`
