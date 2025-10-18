# Class: CLIGenerator

Defined in: [smrt/packages/core/src/generators/cli.ts:59](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/generators/cli.ts#L59)

Generate CLI commands for smrt objects

## Constructors

### Constructor

> **new CLIGenerator**(`config`, `context`): `CLIGenerator`

Defined in: [smrt/packages/core/src/generators/cli.ts:64](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/generators/cli.ts#L64)

#### Parameters

##### config

[`CLIConfig`](../interfaces/CLIConfig.md) = `{}`

##### context

[`CLIContext`](../interfaces/CLIContext.md) = `{}`

#### Returns

`CLIGenerator`

## Methods

### executeCommand()

> **executeCommand**(`parsed`, `commands`): `Promise`\<`void`\>

Defined in: [smrt/packages/core/src/generators/cli.ts:294](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/generators/cli.ts#L294)

Execute a parsed command

#### Parameters

##### parsed

[`ParsedArgs`](../interfaces/ParsedArgs.md)

##### commands

`Command`[]

#### Returns

`Promise`\<`void`\>

***

### generateHandler()

> **generateHandler**(): (`argv`) => `Promise`\<`void`\>

Defined in: [smrt/packages/core/src/generators/cli.ts:102](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/generators/cli.ts#L102)

Generate CLI handler function

#### Returns

> (`argv`): `Promise`\<`void`\>

##### Parameters

###### argv

`string`[]

##### Returns

`Promise`\<`void`\>

***

### generateUtilityCommands()

> **generateUtilityCommands**(): `Command`[]

Defined in: [smrt/packages/core/src/generators/cli.ts:388](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/generators/cli.ts#L388)

Generate utility commands

#### Returns

`Command`[]

***

### showHelp()

> **showHelp**(`commands`): `Promise`\<`void`\>

Defined in: [smrt/packages/core/src/generators/cli.ts:478](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/generators/cli.ts#L478)

Show help information

#### Parameters

##### commands

`Command`[]

#### Returns

`Promise`\<`void`\>
