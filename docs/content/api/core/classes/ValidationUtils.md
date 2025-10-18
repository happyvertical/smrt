# Class: ValidationUtils

Defined in: [smrt/packages/core/src/errors.ts:621](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/errors.ts#L621)

Validation utility functions

## Constructors

### Constructor

> **new ValidationUtils**(): `ValidationUtils`

#### Returns

`ValidationUtils`

## Methods

### validateField()

> `static` **validateField**(`fieldName`, `value`, `options`, `objectType`): `Promise`\<[`ValidationError`](ValidationError.md) \| `null`\>

Defined in: [smrt/packages/core/src/errors.ts:630](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/errors.ts#L630)

Validate a single field value

#### Parameters

##### fieldName

`string`

Name of the field

##### value

`any`

Value to validate

##### options

Validation options (required, min, max, etc.)

###### customMessage?

`string`

###### customValidator?

(`value`) => `boolean` \| `Promise`\<`boolean`\>

###### max?

`number`

###### maxLength?

`number`

###### min?

`number`

###### minLength?

`number`

###### pattern?

`string` \| `RegExp`

###### required?

`boolean`

###### type?

`string`

##### objectType

`string` = `'Object'`

#### Returns

`Promise`\<[`ValidationError`](ValidationError.md) \| `null`\>

ValidationError if validation fails, null otherwise

***

### validateLength()

> `static` **validateLength**(`fieldName`, `value`, `minLength?`, `maxLength?`): [`ValidationError`](ValidationError.md) \| `null`

Defined in: [smrt/packages/core/src/errors.ts:770](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/errors.ts#L770)

Validate string length

#### Parameters

##### fieldName

`string`

##### value

`string`

##### minLength?

`number`

##### maxLength?

`number`

#### Returns

[`ValidationError`](ValidationError.md) \| `null`

***

### validatePattern()

> `static` **validatePattern**(`fieldName`, `value`, `pattern`): [`ValidationError`](ValidationError.md) \| `null`

Defined in: [smrt/packages/core/src/errors.ts:796](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/errors.ts#L796)

Validate string pattern

#### Parameters

##### fieldName

`string`

##### value

`string`

##### pattern

`string` | `RegExp`

#### Returns

[`ValidationError`](ValidationError.md) \| `null`

***

### validateRange()

> `static` **validateRange**(`fieldName`, `value`, `min?`, `max?`): [`ValidationError`](ValidationError.md) \| `null`

Defined in: [smrt/packages/core/src/errors.ts:752](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/errors.ts#L752)

Validate numeric range

#### Parameters

##### fieldName

`string`

##### value

`number`

##### min?

`number`

##### max?

`number`

#### Returns

[`ValidationError`](ValidationError.md) \| `null`

***

### validateRequired()

> `static` **validateRequired**(`fieldName`, `value`, `objectType`): [`ValidationError`](ValidationError.md) \| `null`

Defined in: [smrt/packages/core/src/errors.ts:738](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/errors.ts#L738)

Validate required field

#### Parameters

##### fieldName

`string`

##### value

`any`

##### objectType

`string` = `'Object'`

#### Returns

[`ValidationError`](ValidationError.md) \| `null`
