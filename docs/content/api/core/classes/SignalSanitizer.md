# Class: SignalSanitizer

Defined in: [packages/core/src/signals/sanitizer.ts:75](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/signals/sanitizer.ts#L75)

Signal sanitizer

Removes or redacts sensitive data from signal payloads before
they are processed by adapters.

## Constructors

### Constructor

> **new SignalSanitizer**(`config`): `SignalSanitizer`

Defined in: [packages/core/src/signals/sanitizer.ts:78](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/signals/sanitizer.ts#L78)

#### Parameters

##### config

[`SanitizationConfig`](../interfaces/SanitizationConfig.md) = `{}`

#### Returns

`SignalSanitizer`

## Methods

### sanitize()

> **sanitize**(`signal`): [`Signal`](../interfaces/Signal.md)

Defined in: [packages/core/src/signals/sanitizer.ts:166](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/signals/sanitizer.ts#L166)

Sanitize a signal payload

#### Parameters

##### signal

[`Signal`](../interfaces/Signal.md)

Signal to sanitize

#### Returns

[`Signal`](../interfaces/Signal.md)

Sanitized signal (new object, doesn't mutate original)
