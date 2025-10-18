# Class: ValidationReport

Defined in: [smrt/packages/core/src/errors.ts:539](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/errors.ts#L539)

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

Defined in: [smrt/packages/core/src/errors.ts:543](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/errors.ts#L543)

#### Parameters

##### objectType

`string`

#### Returns

`ValidationReport`

## Methods

### addError()

> **addError**(`error`): `void`

Defined in: [smrt/packages/core/src/errors.ts:550](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/errors.ts#L550)

Add a validation error to the report

#### Parameters

##### error

[`ValidationError`](ValidationError.md)

#### Returns

`void`

***

### clear()

> **clear**(): `void`

Defined in: [smrt/packages/core/src/errors.ts:613](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/errors.ts#L613)

Clear all errors

#### Returns

`void`

***

### getErrorCount()

> **getErrorCount**(): `number`

Defined in: [smrt/packages/core/src/errors.ts:571](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/errors.ts#L571)

Get the number of validation errors

#### Returns

`number`

***

### getErrors()

> **getErrors**(): [`ValidationError`](ValidationError.md)[]

Defined in: [smrt/packages/core/src/errors.ts:564](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/errors.ts#L564)

Get all validation errors

#### Returns

[`ValidationError`](ValidationError.md)[]

***

### hasErrors()

> **hasErrors**(): `boolean`

Defined in: [smrt/packages/core/src/errors.ts:557](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/errors.ts#L557)

Check if there are any validation errors

#### Returns

`boolean`

***

### throwIfErrors()

> **throwIfErrors**(): `void`

Defined in: [smrt/packages/core/src/errors.ts:604](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/errors.ts#L604)

Throw the first error if there are any errors

#### Returns

`void`

***

### toJSON()

> **toJSON**(): `object`

Defined in: [smrt/packages/core/src/errors.ts:593](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/errors.ts#L593)

Convert to JSON format

#### Returns

`object`

***

### toString()

> **toString**(): `string`

Defined in: [smrt/packages/core/src/errors.ts:578](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/errors.ts#L578)

Convert to a human-readable string

#### Returns

`string`
