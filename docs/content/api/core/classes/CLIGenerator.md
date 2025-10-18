# Class: CLIGenerator

Defined in: smrt/packages/core/src/generators/cli.ts:59

Generate CLI commands for smrt objects

## Constructors

### Constructor

> **new CLIGenerator**(`config`, `context`): `CLIGenerator`

Defined in: smrt/packages/core/src/generators/cli.ts:64

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

Defined in: smrt/packages/core/src/generators/cli.ts:294

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

Defined in: smrt/packages/core/src/generators/cli.ts:102

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

Defined in: smrt/packages/core/src/generators/cli.ts:388

Generate utility commands

#### Returns

`Command`[]

***

### showHelp()

> **showHelp**(`commands`): `Promise`\<`void`\>

Defined in: smrt/packages/core/src/generators/cli.ts:478

Show help information

#### Parameters

##### commands

`Command`[]

#### Returns

`Promise`\<`void`\>
