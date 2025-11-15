# Class: ValidationReport

Defined in: [packages/core/src/errors.ts:615](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/errors.ts#L615)

Validation report that collects multiple validation errors

Useful for validating an entire object and reporting all errors
at once rather than stopping at the first error.

## Example

```typescript
const report = new ValidationReport('Product');
report.addError(ValidationError.requiredField('name', 'Product'));
report.addError(ValidationError.rangeError('price', -10, 0));

if (report.hasErrors()) {
  console.error(report.toString());
  // Output:
  // Validation failed for Product with 2 errors:
  // - name: Required field 'name' is missing for Product
  // - price: Value -10 for field 'price' is outside allowed range [0, undefined]
}
```

## Constructors

### Constructor

> **new ValidationReport**(`objectType`): `ValidationReport`

Defined in: [packages/core/src/errors.ts:619](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/errors.ts#L619)

#### Parameters

##### objectType

`string`

#### Returns

`ValidationReport`

## Methods

### addError()

> **addError**(`error`): `void`

Defined in: [packages/core/src/errors.ts:626](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/errors.ts#L626)

Add a validation error to the report

#### Parameters

##### error

[`ValidationError`](ValidationError.md)

#### Returns

`void`

***

### clear()

> **clear**(): `void`

Defined in: [packages/core/src/errors.ts:689](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/errors.ts#L689)

Clear all errors

#### Returns

`void`

***

### getErrorCount()

> **getErrorCount**(): `number`

Defined in: [packages/core/src/errors.ts:647](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/errors.ts#L647)

Get the number of validation errors

#### Returns

`number`

***

### getErrors()

> **getErrors**(): [`ValidationError`](ValidationError.md)[]

Defined in: [packages/core/src/errors.ts:640](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/errors.ts#L640)

Get all validation errors

#### Returns

[`ValidationError`](ValidationError.md)[]

***

### hasErrors()

> **hasErrors**(): `boolean`

Defined in: [packages/core/src/errors.ts:633](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/errors.ts#L633)

Check if there are any validation errors

#### Returns

`boolean`

***

### throwIfErrors()

> **throwIfErrors**(): `void`

Defined in: [packages/core/src/errors.ts:680](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/errors.ts#L680)

Throw the first error if there are any errors

#### Returns

`void`

***

### toJSON()

> **toJSON**(): `object`

Defined in: [packages/core/src/errors.ts:669](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/errors.ts#L669)

Convert to JSON format

#### Returns

`object`

***

### toString()

> **toString**(): `string`

Defined in: [packages/core/src/errors.ts:654](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/errors.ts#L654)

Convert to a human-readable string

#### Returns

`string`
