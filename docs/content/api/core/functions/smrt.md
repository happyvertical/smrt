# Function: smrt()

> **smrt**(`config`): \<`T`\>(`ctor`) => `T`

Defined in: [packages/core/src/registry.ts:2256](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L2256)

## Parameters

### config

[`SmartObjectConfig`](../interfaces/SmartObjectConfig.md) = `{}`

## Returns

> \<`T`\>(`ctor`): `T`

### Type Parameters

#### T

`T` *extends* (...`args`) => `any`

### Parameters

#### ctor

`T`

### Returns

`T`

## Smrt

decorator for registering classes with the global registry

Captures the original class name before minification and stores it as
a static property, ensuring table names remain consistent in production builds.

Supports both SmrtObject and SmrtCollection subclasses.

## Example

```typescript
@smrt()
class Product extends SmrtObject {
  name = text({ required: true });
  price = decimal({ min: 0 });
}

@smrt({ tableName: 'custom_products' })
class ProductCollection extends SmrtCollection<Product> {
  static readonly _itemClass = Product;
}

@smrt({ api: { exclude: ['delete'] } })
class SensitiveData extends SmrtObject {
  secret = text({ encrypted: true });
}
```
