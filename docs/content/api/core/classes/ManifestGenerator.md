# Class: ManifestGenerator

Defined in: [packages/core/src/scanner/manifest-generator.ts:12](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/scanner/manifest-generator.ts#L12)

Static manifest module for runtime use
Uses pre-generated manifest from build time instead of runtime scanning

## Constructors

### Constructor

> **new ManifestGenerator**(): `ManifestGenerator`

#### Returns

`ManifestGenerator`

## Methods

### generateManifest()

> **generateManifest**(`scanResults`, `options?`): [`SmartObjectManifest`](../interfaces/SmartObjectManifest.md)

Defined in: [packages/core/src/scanner/manifest-generator.ts:22](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/scanner/manifest-generator.ts#L22)

Generate manifest from scan results

#### Parameters

##### scanResults

`ScanResult`[]

Array of scan results containing object definitions

##### options?

Optional configuration

###### packageJson?

`any`

Full package.json object for determining import paths

###### packageName?

`string`

Package name to inject into manifest and object definitions

###### packageVersion?

`string`

Package version

#### Returns

[`SmartObjectManifest`](../interfaces/SmartObjectManifest.md)

***

### generateMCPTools()

> **generateMCPTools**(`manifest`): `string`

Defined in: [packages/core/src/scanner/manifest-generator.ts:368](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/scanner/manifest-generator.ts#L368)

Generate simple MCP tool names for testing/documentation

#### Parameters

##### manifest

[`SmartObjectManifest`](../interfaces/SmartObjectManifest.md)

#### Returns

`string`

***

### generateMCPToolsCode()

> **generateMCPToolsCode**(`manifest`): `string`

Defined in: [packages/core/src/scanner/manifest-generator.ts:384](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/scanner/manifest-generator.ts#L384)

Generate MCP tool JSON definitions

#### Parameters

##### manifest

[`SmartObjectManifest`](../interfaces/SmartObjectManifest.md)

#### Returns

`string`

***

### generateRestEndpointCode()

> **generateRestEndpointCode**(`manifest`): `string`

Defined in: [packages/core/src/scanner/manifest-generator.ts:216](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/scanner/manifest-generator.ts#L216)

Generate REST endpoint code implementations

#### Parameters

##### manifest

[`SmartObjectManifest`](../interfaces/SmartObjectManifest.md)

#### Returns

`string`

***

### generateRestEndpoints()

> **generateRestEndpoints**(`manifest`): `string`

Defined in: [packages/core/src/scanner/manifest-generator.ts:200](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/scanner/manifest-generator.ts#L200)

Generate simple endpoint list for testing/documentation

#### Parameters

##### manifest

[`SmartObjectManifest`](../interfaces/SmartObjectManifest.md)

#### Returns

`string`

***

### generateTypeDefinitions()

> **generateTypeDefinitions**(`manifest`): `string`

Defined in: [packages/core/src/scanner/manifest-generator.ts:146](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/scanner/manifest-generator.ts#L146)

Generate TypeScript interfaces from manifest

#### Parameters

##### manifest

[`SmartObjectManifest`](../interfaces/SmartObjectManifest.md)

#### Returns

`string`

***

### loadManifest()

> **loadManifest**(`filePath`): [`SmartObjectManifest`](../interfaces/SmartObjectManifest.md)

Defined in: [packages/core/src/scanner/manifest-generator.ts:560](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/scanner/manifest-generator.ts#L560)

Load manifest from file

#### Parameters

##### filePath

`string`

#### Returns

[`SmartObjectManifest`](../interfaces/SmartObjectManifest.md)

***

### saveManifest()

> **saveManifest**(`manifest`, `filePath`): `void`

Defined in: [packages/core/src/scanner/manifest-generator.ts:552](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/scanner/manifest-generator.ts#L552)

Save manifest to file

#### Parameters

##### manifest

[`SmartObjectManifest`](../interfaces/SmartObjectManifest.md)

##### filePath

`string`

#### Returns

`void`
