# Function: smrt()

> **smrt**(`config`): \<`T`\>(`ctor`) => `T`

Defined in: [smrt/packages/core/src/registry.ts:1309](https://github.com/happyvertical/smrt/blob/bfd2feaea84273ee833a92e2d20c959aedfcfbd9/packages/core/src/registry.ts#L1309)

## Parameters

### config

[`SmartObjectConfig`](../interfaces/SmartObjectConfig.md) = `{}`

## Returns

> \<`T`\>(`ctor`): `T`

### Type Parameters

#### T

`T` *extends* *typeof* [`SmrtObject`](../classes/SmrtObject.md)

### Parameters

#### ctor

`T`

### Returns

`T`

## Smrt

decorator for registering classes with the global registry

Captures the original class name before minification and stores it as
a static property, ensuring table names remain consistent in production builds.

## Example

```typescript
@smrt()
class Product extends SmrtObject {
  name = text({ required: true });
  price = decimal({ min: 0 });
}

@smrt({ tableName: 'custom_products' })
class Product extends SmrtObject {
  name = text({ required: true });
}

@smrt({ api: { exclude: ['delete'] } })
class SensitiveData extends SmrtObject {
  secret = text({ encrypted: true });
}
```
