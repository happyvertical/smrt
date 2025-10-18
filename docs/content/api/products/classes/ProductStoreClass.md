# Class: ProductStoreClass

Defined in: [packages/products/src/lib/stores/product-store.svelte.ts:17](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/products/src/lib/stores/product-store.svelte.ts#L17)

SMRT Template Stores

Svelte 5 rune-based state management for SMRT objects.
These stores integrate with auto-generated SMRT clients.

## Constructors

### Constructor

> **new ProductStoreClass**(): `ProductStoreClass`

#### Returns

`ProductStoreClass`

## Accessors

### categories

#### Get Signature

> **get** **categories**(): `string`[]

Defined in: [packages/products/src/lib/stores/product-store.svelte.ts:53](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/products/src/lib/stores/product-store.svelte.ts#L53)

##### Returns

`string`[]

***

### error

#### Get Signature

> **get** **error**(): `string` \| `null`

Defined in: [packages/products/src/lib/stores/product-store.svelte.ts:34](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/products/src/lib/stores/product-store.svelte.ts#L34)

##### Returns

`string` \| `null`

***

### inStockCount

#### Get Signature

> **get** **inStockCount**(): `number`

Defined in: [packages/products/src/lib/stores/product-store.svelte.ts:42](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/products/src/lib/stores/product-store.svelte.ts#L42)

##### Returns

`number`

***

### items

#### Get Signature

> **get** **items**(): `ProductData`[]

Defined in: [packages/products/src/lib/stores/product-store.svelte.ts:28](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/products/src/lib/stores/product-store.svelte.ts#L28)

##### Returns

`ProductData`[]

***

### loading

#### Get Signature

> **get** **loading**(): `boolean`

Defined in: [packages/products/src/lib/stores/product-store.svelte.ts:31](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/products/src/lib/stores/product-store.svelte.ts#L31)

##### Returns

`boolean`

***

### selectedProduct

#### Get Signature

> **get** **selectedProduct**(): `ProductData` \| `null`

Defined in: [packages/products/src/lib/stores/product-store.svelte.ts:37](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/products/src/lib/stores/product-store.svelte.ts#L37)

##### Returns

`ProductData` \| `null`

***

### totalValue

#### Get Signature

> **get** **totalValue**(): `number`

Defined in: [packages/products/src/lib/stores/product-store.svelte.ts:46](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/products/src/lib/stores/product-store.svelte.ts#L46)

##### Returns

`number`

## Methods

### clearError()

> **clearError**(): `void`

Defined in: [packages/products/src/lib/stores/product-store.svelte.ts:149](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/products/src/lib/stores/product-store.svelte.ts#L149)

#### Returns

`void`

***

### createProduct()

> **createProduct**(`productData`): `Promise`\<`ApiResponse`\<`ProductData`\>\>

Defined in: [packages/products/src/lib/stores/product-store.svelte.ts:78](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/products/src/lib/stores/product-store.svelte.ts#L78)

#### Parameters

##### productData

`Partial`\<`ProductData`\>

#### Returns

`Promise`\<`ApiResponse`\<`ProductData`\>\>

***

### deleteProduct()

> **deleteProduct**(`id`): `Promise`\<`void`\>

Defined in: [packages/products/src/lib/stores/product-store.svelte.ts:124](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/products/src/lib/stores/product-store.svelte.ts#L124)

#### Parameters

##### id

`string`

#### Returns

`Promise`\<`void`\>

***

### filterByCategory()

> **filterByCategory**(`category`): `ProductData`[]

Defined in: [packages/products/src/lib/stores/product-store.svelte.ts:154](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/products/src/lib/stores/product-store.svelte.ts#L154)

#### Parameters

##### category

`string`

#### Returns

`ProductData`[]

***

### filterInStock()

> **filterInStock**(): `ProductData`[]

Defined in: [packages/products/src/lib/stores/product-store.svelte.ts:158](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/products/src/lib/stores/product-store.svelte.ts#L158)

#### Returns

`ProductData`[]

***

### loadProducts()

> **loadProducts**(): `Promise`\<`void`\>

Defined in: [packages/products/src/lib/stores/product-store.svelte.ts:61](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/products/src/lib/stores/product-store.svelte.ts#L61)

#### Returns

`Promise`\<`void`\>

***

### searchProducts()

> **searchProducts**(`query`): `ProductData`[]

Defined in: [packages/products/src/lib/stores/product-store.svelte.ts:162](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/products/src/lib/stores/product-store.svelte.ts#L162)

#### Parameters

##### query

`string`

#### Returns

`ProductData`[]

***

### selectProduct()

> **selectProduct**(`product`): `void`

Defined in: [packages/products/src/lib/stores/product-store.svelte.ts:145](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/products/src/lib/stores/product-store.svelte.ts#L145)

#### Parameters

##### product

`ProductData` | `null`

#### Returns

`void`

***

### updateProduct()

> **updateProduct**(`id`, `updates`): `Promise`\<`ApiResponse`\<`ProductData`\>\>

Defined in: [packages/products/src/lib/stores/product-store.svelte.ts:97](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/products/src/lib/stores/product-store.svelte.ts#L97)

#### Parameters

##### id

`string`

##### updates

`Partial`\<`ProductData`\>

#### Returns

`Promise`\<`ApiResponse`\<`ProductData`\>\>
