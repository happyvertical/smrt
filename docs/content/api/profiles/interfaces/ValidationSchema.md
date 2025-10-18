# Interface: ValidationSchema

Defined in: profiles/src/types.ts:23

Validation schema structure for profile metadata fields

## Properties

### custom?

> `optional` **custom**: `string`

Defined in: profiles/src/types.ts:43

Custom validator function name

***

### max?

> `optional` **max**: `number`

Defined in: profiles/src/types.ts:40

Maximum numeric value

***

### maxLength?

> `optional` **maxLength**: `number`

Defined in: profiles/src/types.ts:34

Maximum string length

***

### message?

> `optional` **message**: `string`

Defined in: profiles/src/types.ts:46

Custom validation error message

***

### min?

> `optional` **min**: `number`

Defined in: profiles/src/types.ts:37

Minimum numeric value

***

### minLength?

> `optional` **minLength**: `number`

Defined in: profiles/src/types.ts:31

Minimum string length

***

### pattern?

> `optional` **pattern**: `string`

Defined in: profiles/src/types.ts:28

Regex pattern for string validation

***

### type?

> `optional` **type**: `"string"` \| `"number"` \| `"boolean"` \| `"date"` \| `"json"`

Defined in: profiles/src/types.ts:25

Type constraint
