# Class: SignalSanitizer

Defined in: [smrt/packages/core/src/signals/sanitizer.ts:75](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/signals/sanitizer.ts#L75)

Signal sanitizer

Removes or redacts sensitive data from signal payloads before
they are processed by adapters.

## Constructors

### Constructor

> **new SignalSanitizer**(`config`): `SignalSanitizer`

Defined in: [smrt/packages/core/src/signals/sanitizer.ts:78](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/signals/sanitizer.ts#L78)

#### Parameters

##### config

[`SanitizationConfig`](../interfaces/SanitizationConfig.md) = `{}`

#### Returns

`SignalSanitizer`

## Methods

### sanitize()

> **sanitize**(`signal`): `Signal`

Defined in: [smrt/packages/core/src/signals/sanitizer.ts:166](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/signals/sanitizer.ts#L166)

Sanitize a signal payload

#### Parameters

##### signal

`Signal`

Signal to sanitize

#### Returns

`Signal`

Sanitized signal (new object, doesn't mutate original)
