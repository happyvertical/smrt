# Interface: ValidationSchema

Defined in: [profiles/src/types.ts:23](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/profiles/src/types.ts#L23)

Validation schema structure for profile metadata fields

## Properties

### custom?

> `optional` **custom**: `string`

Defined in: [profiles/src/types.ts:43](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/profiles/src/types.ts#L43)

Custom validator function name

***

### max?

> `optional` **max**: `number`

Defined in: [profiles/src/types.ts:40](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/profiles/src/types.ts#L40)

Maximum numeric value

***

### maxLength?

> `optional` **maxLength**: `number`

Defined in: [profiles/src/types.ts:34](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/profiles/src/types.ts#L34)

Maximum string length

***

### message?

> `optional` **message**: `string`

Defined in: [profiles/src/types.ts:46](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/profiles/src/types.ts#L46)

Custom validation error message

***

### min?

> `optional` **min**: `number`

Defined in: [profiles/src/types.ts:37](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/profiles/src/types.ts#L37)

Minimum numeric value

***

### minLength?

> `optional` **minLength**: `number`

Defined in: [profiles/src/types.ts:31](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/profiles/src/types.ts#L31)

Minimum string length

***

### pattern?

> `optional` **pattern**: `string`

Defined in: [profiles/src/types.ts:28](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/profiles/src/types.ts#L28)

Regex pattern for string validation

***

### type?

> `optional` **type**: `"string"` \| `"number"` \| `"boolean"` \| `"date"` \| `"json"`

Defined in: [profiles/src/types.ts:25](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/profiles/src/types.ts#L25)

Type constraint
