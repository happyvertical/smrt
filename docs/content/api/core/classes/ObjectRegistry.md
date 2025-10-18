# Class: ObjectRegistry

Defined in: [smrt/packages/core/src/registry.ts:234](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/registry.ts#L234)

Central registry for all SMRT objects

## Constructors

### Constructor

> **new ObjectRegistry**(): `ObjectRegistry`

#### Returns

`ObjectRegistry`

## Methods

### clear()

> `static` **clear**(): `void`

Defined in: [smrt/packages/core/src/registry.ts:409](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/registry.ts#L409)

Clear all registered classes (mainly for testing)

#### Returns

`void`

***

### extractFields()

> `static` **extractFields**(`ctor`): `Map`\<`string`, `any`\>

Defined in: [smrt/packages/core/src/registry.ts:520](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/registry.ts#L520)

Extract field definitions from a class constructor

#### Parameters

##### ctor

*typeof* [`SmrtObject`](SmrtObject.md)

#### Returns

`Map`\<`string`, `any`\>

***

### getAllClasses()

> `static` **getAllClasses**(): `Map`\<`string`, `RegisteredClass`\>

Defined in: [smrt/packages/core/src/registry.ts:388](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/registry.ts#L388)

Get all registered classes

#### Returns

`Map`\<`string`, `RegisteredClass`\>

Map of class names to registered class information

#### Example

```typescript
const allClasses = ObjectRegistry.getAllClasses();
for (const [name, info] of allClasses) {
  console.log(`Class: ${name}, Fields: ${info.fields.size}`);
}
```

***

### getAllObjectMetadata()

> `static` **getAllObjectMetadata**(): `object`[]

Defined in: [smrt/packages/core/src/registry.ts:1158](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/registry.ts#L1158)

Get metadata for all registered objects (convenience method)

Returns comprehensive metadata for every registered object, combining
multiple registry queries into a single convenient data structure.

This is particularly useful for:
- Admin dashboards showing all objects
- Documentation generation
- Schema visualization
- Debugging and introspection

#### Returns

`object`[]

Array of complete metadata objects for all registered classes

#### Example

```typescript
const allMetadata = ObjectRegistry.getAllObjectMetadata();

// Generate admin dashboard
for (const meta of allMetadata) {
  console.log(`${meta.name}:`);
  console.log(`  Table: ${meta.schema?.tableName}`);
  console.log(`  Fields: ${meta.fields.size}`);
  console.log(`  API: ${meta.config.api ? 'enabled' : 'disabled'}`);
  console.log(`  Relationships: ${meta.relationships.length}`);
}

// Generate schema documentation
const schemaDoc = allMetadata.map(meta => ({
  name: meta.name,
  table: meta.schema?.tableName,
  fields: Array.from(meta.fields.entries()).map(([name, field]) => ({
    name,
    type: field.type,
    required: field.options?.required || false
  })),
  relationships: meta.relationships.map(rel => ({
    field: rel.fieldName,
    target: rel.targetClass,
    type: rel.type
  }))
}));
```

***

### getClass()

> `static` **getClass**(`name`): `RegisteredClass` \| `undefined`

Defined in: [smrt/packages/core/src/registry.ts:372](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/registry.ts#L372)

Get a registered class by name (case-insensitive)

#### Parameters

##### name

`string`

Name of the registered class

#### Returns

`RegisteredClass` \| `undefined`

Registered class information or undefined if not found

#### Example

```typescript
const productInfo = ObjectRegistry.getClass('Product');
// Also works with: 'product', 'PRODUCT', etc.
if (productInfo) {
  console.log(productInfo.config.api?.exclude);
}
```

***

### getClassNames()

> `static` **getClassNames**(): `string`[]

Defined in: [smrt/packages/core/src/registry.ts:395](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/registry.ts#L395)

Get class names

#### Returns

`string`[]

***

### getCollection()

> `static` **getCollection**\<`T`\>(`className`, `options`): `Promise`\<[`SmrtCollection`](SmrtCollection.md)\<`T`\>\>

Defined in: [smrt/packages/core/src/registry.ts:459](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/registry.ts#L459)

Get or create a cached collection instance (Singleton pattern - Phase 4 optimization)

Returns a cached collection if one exists for the given class and options,
otherwise creates, initializes, and caches a new instance. This significantly
improves performance by avoiding repeated collection initialization.

**Performance Impact**: 60-80% reduction in collection initialization overhead

**Cache Key Strategy**: Collections are cached based on:
- className
- persistence configuration (type, url, baseUrl)
- db presence (not full config)
- ai presence (not full config)

Different persistence configurations create separate cached instances.

#### Type Parameters

##### T

`T` *extends* [`SmrtObject`](SmrtObject.md)

#### Parameters

##### className

`string`

Name of the object class

##### options

`any` = `{}`

Configuration options for the collection

#### Returns

`Promise`\<[`SmrtCollection`](SmrtCollection.md)\<`T`\>\>

Cached or newly created collection instance

#### Throws

If the class is not registered or has no collection

#### Example

```typescript
// First call creates and caches the collection
const orders1 = await ObjectRegistry.getCollection('Order', {
  persistence: { type: 'sql', url: 'orders.db' }
});

// Subsequent calls return the cached instance (much faster)
const orders2 = await ObjectRegistry.getCollection('Order', {
  persistence: { type: 'sql', url: 'orders.db' }
});
console.log(orders1 === orders2); // true (same instance)

// Different configuration creates new instance
const orders3 = await ObjectRegistry.getCollection('Order', {
  persistence: { type: 'sql', url: 'orders-copy.db' }
});
console.log(orders1 === orders3); // false (different config)
```

#### See

[4 Documentation](https://github.com/happyvertical/sdk/blob/main/packages/core/CLAUDE.md#singleton-collection-management-phase-4|Phase)

***

### getConfig()

> `static` **getConfig**(`name`): [`SmartObjectConfig`](../interfaces/SmartObjectConfig.md)

Defined in: [smrt/packages/core/src/registry.ts:785](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/registry.ts#L785)

Get configuration for a registered class

#### Parameters

##### name

`string`

#### Returns

[`SmartObjectConfig`](../interfaces/SmartObjectConfig.md)

***

### getDependencyGraph()

> `static` **getDependencyGraph**(): `Map`\<`string`, `string`[]\>

Defined in: [smrt/packages/core/src/registry.ts:872](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/registry.ts#L872)

Build dependency graph from foreignKey relationships

Returns a map where keys are class names and values are arrays
of class names that the key depends on (via foreignKey fields).

#### Returns

`Map`\<`string`, `string`[]\>

Map of class name to array of dependency class names

#### Example

```typescript
const deps = ObjectRegistry.getDependencyGraph();
// { 'Order': ['Customer', 'Product'], 'Customer': [], 'Product': ['Category'] }
```

***

### getFields()

> `static` **getFields**(`name`): `Map`\<`string`, `any`\>

Defined in: [smrt/packages/core/src/registry.ts:777](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/registry.ts#L777)

Get field definitions for a registered class

#### Parameters

##### name

`string`

#### Returns

`Map`\<`string`, `any`\>

***

### getInitializationOrder()

> `static` **getInitializationOrder**(): `string`[]

Defined in: [smrt/packages/core/src/registry.ts:915](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/registry.ts#L915)

Get initialization order for classes based on dependency graph

Uses topological sort to ensure that classes are initialized in
an order that respects foreignKey dependencies (dependencies first).

#### Returns

`string`[]

Array of class names in initialization order

#### Throws

If circular dependencies are detected

#### Example

```typescript
const order = ObjectRegistry.getInitializationOrder();
// ['Category', 'Product', 'Customer', 'Order']
// Tables are created in this order to avoid foreign key errors
```

***

### getInverseRelationships()

> `static` **getInverseRelationships**(`className`): [`RelationshipMetadata`](../interfaces/RelationshipMetadata.md)[]

Defined in: [smrt/packages/core/src/registry.ts:1200](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/registry.ts#L1200)

Get inverse relationships (relationships where this class is the target)

#### Parameters

##### className

`string`

Name of the class to find inverse relationships for

#### Returns

[`RelationshipMetadata`](../interfaces/RelationshipMetadata.md)[]

Array of relationship metadata where this class is the target

#### Example

```typescript
const customerInverseRels = ObjectRegistry.getInverseRelationships('Customer');
// [{ sourceClass: 'Order', fieldName: 'customerId', targetClass: 'Customer', ... }]
```

***

### getObjectMetadata()

> `static` **getObjectMetadata**(`className`): \{ `collectionConstructor?`: (`options`) => [`SmrtCollection`](SmrtCollection.md)\<`any`\>; `config`: [`SmartObjectConfig`](../interfaces/SmartObjectConfig.md); `constructor`: *typeof* [`SmrtObject`](SmrtObject.md); `fields`: `Map`\<`string`, `any`\>; `inverseRelationships`: [`RelationshipMetadata`](../interfaces/RelationshipMetadata.md)[]; `name`: `string`; `relationships`: [`RelationshipMetadata`](../interfaces/RelationshipMetadata.md)[]; `schema`: `SchemaDefinition` \| `undefined`; `tools?`: `object`[]; `validators`: `ValidatorFunction`[]; \} \| `null`

Defined in: [smrt/packages/core/src/registry.ts:1077](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/registry.ts#L1077)

Get complete metadata for a single object (convenience method)

Returns all available metadata for an object in a single call, including:
- Class information
- Field definitions
- Configuration
- Schema definition
- Validators
- Relationships
- Tools (AI-callable methods)

This is a convenience method that aggregates multiple registry queries
into a single comprehensive metadata object.

#### Parameters

##### className

`string`

Name of the class to get metadata for

#### Returns

\{ `collectionConstructor?`: (`options`) => [`SmrtCollection`](SmrtCollection.md)\<`any`\>; `config`: [`SmartObjectConfig`](../interfaces/SmartObjectConfig.md); `constructor`: *typeof* [`SmrtObject`](SmrtObject.md); `fields`: `Map`\<`string`, `any`\>; `inverseRelationships`: [`RelationshipMetadata`](../interfaces/RelationshipMetadata.md)[]; `name`: `string`; `relationships`: [`RelationshipMetadata`](../interfaces/RelationshipMetadata.md)[]; `schema`: `SchemaDefinition` \| `undefined`; `tools?`: `object`[]; `validators`: `ValidatorFunction`[]; \} \| `null`

Complete metadata object or null if class not found

#### Example

```typescript
const productMeta = ObjectRegistry.getObjectMetadata('Product');
if (productMeta) {
  console.log('Name:', productMeta.name);
  console.log('Table:', productMeta.schema.tableName);
  console.log('Fields:', productMeta.fields.size);
  console.log('API config:', productMeta.config.api);
  console.log('Relationships:', productMeta.relationships.length);
}
```

***

### getRelationshipMap()

> `static` **getRelationshipMap**(): `Map`\<`string`, [`RelationshipMetadata`](../interfaces/RelationshipMetadata.md)[]\>

Defined in: [smrt/packages/core/src/registry.ts:980](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/registry.ts#L980)

Build comprehensive relationship map from all field types

Returns a map containing all relationships (foreignKey, oneToMany, manyToMany)
discovered in registered classes. This enables runtime relationship traversal
and eager/lazy loading of related objects.

#### Returns

`Map`\<`string`, [`RelationshipMetadata`](../interfaces/RelationshipMetadata.md)[]\>

Map of class name to array of relationship metadata

#### Example

```typescript
const relationships = ObjectRegistry.getRelationshipMap();
// {
//   'Order': [
//     { sourceClass: 'Order', fieldName: 'customerId', targetClass: 'Customer',
//       type: 'foreignKey', options: { onDelete: 'restrict' } }
//   ],
//   'Customer': [
//     { sourceClass: 'Customer', fieldName: 'orders', targetClass: 'Order',
//       type: 'oneToMany', options: {} }
//   ]
// }
```

***

### getRelationships()

> `static` **getRelationships**(`className`): [`RelationshipMetadata`](../interfaces/RelationshipMetadata.md)[]

Defined in: [smrt/packages/core/src/registry.ts:1044](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/registry.ts#L1044)

Get relationships for a specific class

#### Parameters

##### className

`string`

Name of the class to get relationships for

#### Returns

[`RelationshipMetadata`](../interfaces/RelationshipMetadata.md)[]

Array of relationship metadata for the class

#### Example

```typescript
const orderRelationships = ObjectRegistry.getRelationships('Order');
// [{ sourceClass: 'Order', fieldName: 'customerId', ... }]
```

***

### getSchema()

> `static` **getSchema**(`name`): `SchemaDefinition` \| `undefined`

Defined in: [smrt/packages/core/src/registry.ts:802](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/registry.ts#L802)

Get cached schema definition for a registered class

#### Parameters

##### name

`string`

Name of the registered class

#### Returns

`SchemaDefinition` \| `undefined`

Schema definition or undefined if not found

#### Example

```typescript
const schema = ObjectRegistry.getSchema('Product');
console.log(schema.tableName); // 'products'
console.log(schema.ddl);       // 'CREATE TABLE...'
```

***

### getSchemaDDL()

> `static` **getSchemaDDL**(`name`): `string` \| `undefined`

Defined in: [smrt/packages/core/src/registry.ts:818](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/registry.ts#L818)

Get SQL DDL statement for a registered class

#### Parameters

##### name

`string`

Name of the registered class

#### Returns

`string` \| `undefined`

SQL DDL statement or undefined if not found

#### Example

```typescript
const ddl = ObjectRegistry.getSchemaDDL('Product');
await db.query(ddl);
```

***

### getTableName()

> `static` **getTableName**(`name`): `string` \| `undefined`

Defined in: [smrt/packages/core/src/registry.ts:833](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/registry.ts#L833)

Get table name for a registered class

#### Parameters

##### name

`string`

Name of the registered class

#### Returns

`string` \| `undefined`

Table name or undefined if not found

#### Example

```typescript
const tableName = ObjectRegistry.getTableName('Product');
console.log(tableName); // 'products'
```

***

### getValidators()

> `static` **getValidators**(`name`): `ValidatorFunction`[] \| `undefined`

Defined in: [smrt/packages/core/src/registry.ts:854](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/registry.ts#L854)

Get compiled validation functions for a registered class

Returns pre-compiled validation functions that can be executed
at runtime for efficient validation without repeated setup.

#### Parameters

##### name

`string`

Name of the registered class

#### Returns

`ValidatorFunction`[] \| `undefined`

Array of validation functions or undefined if not found

#### Example

```typescript
const validators = ObjectRegistry.getValidators('Product');
for (const validator of validators || []) {
  const error = await validator(productInstance);
  if (error) console.error(error);
}
```

***

### hasClass()

> `static` **hasClass**(`name`): `boolean`

Defined in: [smrt/packages/core/src/registry.ts:402](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/registry.ts#L402)

Check if a class is registered (case-insensitive)

#### Parameters

##### name

`string`

#### Returns

`boolean`

***

### loadFromDatabase()

> `static` **loadFromDatabase**(`db`): `Promise`\<`any`[]\>

Defined in: [smrt/packages/core/src/registry.ts:1283](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/registry.ts#L1283)

Load registry metadata from system tables

Reads the _smrt_registry system table to inspect what classes
have been registered. This is primarily for introspection and
debugging - actual class registration happens via @smrt() decorator.

#### Parameters

##### db

`DatabaseInterface`

Database interface to load from

#### Returns

`Promise`\<`any`[]\>

Promise resolving to array of class metadata

#### Example

```typescript
const metadata = await ObjectRegistry.loadFromDatabase(db);
for (const meta of metadata) {
  console.log(`Class: ${meta.class_name}`);
  console.log(`Table: ${JSON.parse(meta.manifest).tableName}`);
}
```

***

### persistToDatabase()

> `static` **persistToDatabase**(`db`): `Promise`\<`void`\>

Defined in: [smrt/packages/core/src/registry.ts:1234](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/registry.ts#L1234)

Persist registry state to system tables

Saves all registered class metadata to the _smrt_registry system table
for runtime introspection and debugging. This enables applications to
query what SMRT objects exist and their configurations.

#### Parameters

##### db

`DatabaseInterface`

Database interface to persist to

#### Returns

`Promise`\<`void`\>

Promise that resolves when persistence is complete

#### Example

```typescript
// After registering all classes
await ObjectRegistry.persistToDatabase(db);

// Later, query the system table
const rows = await db.all('SELECT * FROM _smrt_registry');
console.log('Registered classes:', rows.map(r => r.class_name));
```

***

### register()

> `static` **register**(`ctor`, `config`): `void`

Defined in: [smrt/packages/core/src/registry.ts:254](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/registry.ts#L254)

Register a new SMRT object class with the global registry

#### Parameters

##### ctor

*typeof* [`SmrtObject`](SmrtObject.md)

##### config

[`SmartObjectConfig`](../interfaces/SmartObjectConfig.md) = `{}`

Configuration options for API/CLI/MCP generation

#### Returns

`void`

#### Throws

If the class cannot be introspected for field definitions

#### Example

```typescript
ObjectRegistry.register(Product, {
  api: { exclude: ['delete'] },
  cli: true,
  mcp: { include: ['list', 'get'] }
});
```

***

### registerCollection()

> `static` **registerCollection**(`objectName`, `collectionConstructor`): `void`

Defined in: [smrt/packages/core/src/registry.ts:320](https://github.com/happyvertical/smrt/blob/71a16025d52b026725fd522a392015e67e1d6489/packages/core/src/registry.ts#L320)

Register a collection class for an object

#### Parameters

##### objectName

`string`

Name of the object class this collection manages

##### collectionConstructor

(`options`) => [`SmrtCollection`](SmrtCollection.md)\<`any`\>

The collection class constructor

#### Returns

`void`

#### Example

```typescript
ObjectRegistry.registerCollection('Product', ProductCollection);
```
