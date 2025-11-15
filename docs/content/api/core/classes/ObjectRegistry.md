# Class: ObjectRegistry

Defined in: [packages/core/src/registry.ts:302](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L302)

Central registry for all SMRT objects

## Constructors

### Constructor

> **new ObjectRegistry**(): `ObjectRegistry`

#### Returns

`ObjectRegistry`

## Methods

### clear()

> `static` **clear**(): `void`

Defined in: [packages/core/src/registry.ts:713](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L713)

Clear all registered classes (mainly for testing)

#### Returns

`void`

***

### ensureManifestLoaded()

> `static` **ensureManifestLoaded**(`className`): `Promise`\<`void`\>

Defined in: [packages/core/src/registry.ts:1100](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L1100)

Ensure manifest is loaded for external package classes

For classes from external packages, the manifest may not be loaded during
initial registration (which must be synchronous for decorator support).
This method loads the manifest asynchronously when needed.

#### Parameters

##### className

`string`

Name of the class to ensure manifest is loaded for

#### Returns

`Promise`\<`void`\>

Promise that resolves when manifest is loaded (or already loaded)

#### Throws

If manifest cannot be found

#### Example

```typescript
// Before using fields from external package
await ObjectRegistry.ensureManifestLoaded('Place');
const fields = ObjectRegistry.getFields('Place'); // Now has fields
```

***

### getAllClasses()

> `static` **getAllClasses**(): `Map`\<`string`, `RegisteredClass`\>

Defined in: [packages/core/src/registry.ts:692](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L692)

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

### getAllFields()

> `static` **getAllFields**(`className`): `Promise`\<`Map`\<`string`, `any`\>\>

Defined in: [packages/core/src/registry.ts:1562](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L1562)

Get all fields including inherited ones from parent classes

Walks the full inheritance chain and merges fields:
- Parent fields are added first
- Child fields override parent fields with same name
- Field configs are merged (see mergeFieldConfigs for details)

Results are cached per-class for performance.

#### Parameters

##### className

`string`

Name of the registered class

#### Returns

`Promise`\<`Map`\<`string`, `any`\>\>

Map of all fields (own + inherited) with merged configurations

#### Example

```typescript
// Given: Content → PraecoContent → BentleyContent
const allFields = ObjectRegistry.getAllFields('BentleyContent');
// Includes: title, body (from Content) + praecoCustom1 (from PraecoContent) + bentleyCustom1 (from BentleyContent)
```

***

### getAllMethods()

> `static` **getAllMethods**(`className`): `Promise`\<`Map`\<`string`, `any`\>\>

Defined in: [packages/core/src/registry.ts:1781](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L1781)

Get all methods including inherited ones from parent classes

Walks the full inheritance chain and merges methods:
- Parent methods are added first
- Child methods override parent methods (no config merging for methods)

Results are cached per-class for performance.

**Note:** This is an async method that ensures manifests are loaded for external package classes.

#### Parameters

##### className

`string`

Name of the registered class

#### Returns

`Promise`\<`Map`\<`string`, `any`\>\>

Promise resolving to Map of all methods (own + inherited)

#### Example

```typescript
// Given: Content → PraecoContent → BentleyContent
const allMethods = await ObjectRegistry.getAllMethods('BentleyContent');
// Includes: generateSummary() (from PraecoContent) + analyzeLocal() (from BentleyContent)
```

***

### getAllObjectMetadata()

> `static` **getAllObjectMetadata**(): `object`[]

Defined in: [packages/core/src/registry.ts:1944](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L1944)

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

Defined in: [packages/core/src/registry.ts:676](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L676)

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

Defined in: [packages/core/src/registry.ts:699](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L699)

Get class names

#### Returns

`string`[]

***

### getCollection()

> `static` **getCollection**\<`T`\>(`className`, `options`): `Promise`\<[`SmrtCollection`](SmrtCollection.md)\<`T`\>\>

Defined in: [packages/core/src/registry.ts:817](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L817)

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

Defined in: [packages/core/src/registry.ts:1196](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L1196)

Get configuration for a registered class

#### Parameters

##### name

`string`

#### Returns

[`SmartObjectConfig`](../interfaces/SmartObjectConfig.md)

***

### getDependencyGraph()

> `static` **getDependencyGraph**(): `Map`\<`string`, `string`[]\>

Defined in: [packages/core/src/registry.ts:1283](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L1283)

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

### getDescendants()

> `static` **getDescendants**(`className`): `string`[]

Defined in: [packages/core/src/registry.ts:2131](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L2131)

Get all descendant classes of a base class

Returns all registered classes that inherit from the specified base class.
Uses the `extends` field from manifest to build the descendant tree.

**Use cases:**
- Schema generation: Aggregate fields from all children for STI table
- Polymorphic queries: Find all types to instantiate
- Documentation: Show class hierarchy

#### Parameters

##### className

`string`

Name of the base class

#### Returns

`string`[]

Array of descendant class names (direct and indirect)

#### Example

```typescript
@smrt({ tableStrategy: 'sti' })
class Event extends SmrtObject { }

@smrt()
class Meeting extends Event { }

@smrt()
class HockeyGame extends Event { }

ObjectRegistry.getDescendants('Event'); // ['Meeting', 'HockeyGame']
```

***

### getFields()

> `static` **getFields**(`name`): `Map`\<`string`, `any`\>

Defined in: [packages/core/src/registry.ts:1052](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L1052)

Get field definitions for a registered class

#### Parameters

##### name

`string`

#### Returns

`Map`\<`string`, `any`\>

***

### getInheritanceChain()

> `static` **getInheritanceChain**(`className`): `string`[]

Defined in: [packages/core/src/registry.ts:1512](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L1512)

Get full inheritance chain for a class

Returns array of class names from base (SmrtObject) to child.
Results are cached globally for performance (~100x faster than re-walking).

#### Parameters

##### className

`string`

Name of the registered class

#### Returns

`string`[]

Array of class names from base to child, or empty array if not found

#### Example

```typescript
const chain = ObjectRegistry.getInheritanceChain('BentleyContent');
// ['SmrtObject', 'Content', 'PraecoContent', 'BentleyContent']
```

***

### getInitializationOrder()

> `static` **getInitializationOrder**(): `string`[]

Defined in: [packages/core/src/registry.ts:1326](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L1326)

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

Defined in: [packages/core/src/registry.ts:1987](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L1987)

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

### getMethods()

> `static` **getMethods**(`name`): `Map`\<`string`, `any`\>

Defined in: [packages/core/src/registry.ts:1077](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L1077)

Get method definitions for a registered class

Returns method metadata extracted from the manifest during AST scanning.
This enables code generators (CLI, API, MCP) to discover custom methods
and automatically generate corresponding commands/endpoints/tools.

#### Parameters

##### name

`string`

Name of the registered class

#### Returns

`Map`\<`string`, `any`\>

Map of method names to MethodDefinition objects

#### Example

```typescript
const methods = ObjectRegistry.getMethods('Agent');
for (const [name, methodDef] of methods) {
  console.log(`Method: ${name}`);
  console.log(`  Async: ${methodDef.async}`);
  console.log(`  Public: ${methodDef.isPublic}`);
  console.log(`  Params: ${methodDef.parameters.map(p => p.name).join(', ')}`);
}
```

***

### getObjectMetadata()

> `static` **getObjectMetadata**(`className`): \{ `collectionConstructor?`: (`options`) => [`SmrtCollection`](SmrtCollection.md)\<`any`\>; `config`: [`SmartObjectConfig`](../interfaces/SmartObjectConfig.md); `constructor`: *typeof* [`SmrtObject`](SmrtObject.md); `fields`: `Map`\<`string`, `any`\>; `inverseRelationships`: [`RelationshipMetadata`](../interfaces/RelationshipMetadata.md)[]; `methods`: `Map`\<`string`, `any`\>; `name`: `string`; `relationships`: [`RelationshipMetadata`](../interfaces/RelationshipMetadata.md)[]; `schema`: `SchemaDefinition` \| `undefined`; `tools?`: `object`[]; `validators`: `ValidatorFunction`[]; \} \| `null`

Defined in: [packages/core/src/registry.ts:1861](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L1861)

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

\{ `collectionConstructor?`: (`options`) => [`SmrtCollection`](SmrtCollection.md)\<`any`\>; `config`: [`SmartObjectConfig`](../interfaces/SmartObjectConfig.md); `constructor`: *typeof* [`SmrtObject`](SmrtObject.md); `fields`: `Map`\<`string`, `any`\>; `inverseRelationships`: [`RelationshipMetadata`](../interfaces/RelationshipMetadata.md)[]; `methods`: `Map`\<`string`, `any`\>; `name`: `string`; `relationships`: [`RelationshipMetadata`](../interfaces/RelationshipMetadata.md)[]; `schema`: `SchemaDefinition` \| `undefined`; `tools?`: `object`[]; `validators`: `ValidatorFunction`[]; \} \| `null`

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

Defined in: [packages/core/src/registry.ts:1391](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L1391)

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

Defined in: [packages/core/src/registry.ts:1455](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L1455)

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

Defined in: [packages/core/src/registry.ts:1213](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L1213)

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

Defined in: [packages/core/src/registry.ts:1229](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L1229)

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

### getSTIBase()

> `static` **getSTIBase**(`className`): `string` \| `null`

Defined in: [packages/core/src/registry.ts:2075](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L2075)

Get the base class for an STI hierarchy

Walks up the inheritance chain to find the first class configured
with `tableStrategy: 'sti'`. This is the class that owns the shared table.

**Returns:**
- The base class name if STI is configured in the hierarchy
- null if the class uses CTI strategy

#### Parameters

##### className

`string`

Name of the class to find STI base for

#### Returns

`string` \| `null`

Base class name or null if CTI

#### Example

```typescript
@smrt({ tableStrategy: 'sti' })
class Event extends SmrtObject { }

@smrt()
class Meeting extends Event { }

ObjectRegistry.getSTIBase('Meeting'); // 'Event'
ObjectRegistry.getSTIBase('Event'); // 'Event'
```

***

### getTableName()

> `static` **getTableName**(`name`): `string` \| `undefined`

Defined in: [packages/core/src/registry.ts:1244](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L1244)

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

### getTableStrategy()

> `static` **getTableStrategy**(`className`): `"cti"` \| `"sti"`

Defined in: [packages/core/src/registry.ts:2028](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L2028)

Get table inheritance strategy for a class

Returns the table strategy (CTI or STI) for a class, with automatic
inheritance from parent classes. If not explicitly configured,
walks up the inheritance chain to find the strategy.

**Strategy Inheritance:**
- Set once on base class, children inherit automatically
- Children can explicitly override (not recommended)
- Default is 'cti' if not found in hierarchy

#### Parameters

##### className

`string`

Name of the class to get strategy for

#### Returns

`"cti"` \| `"sti"`

'cti' (Class Table Inheritance) or 'sti' (Single Table Inheritance)

#### Example

```typescript
@smrt({ tableStrategy: 'sti' })
class Event extends SmrtObject { }

@smrt() // Inherits 'sti'
class Meeting extends Event { }

ObjectRegistry.getTableStrategy('Meeting'); // 'sti'
ObjectRegistry.getTableStrategy('Event'); // 'sti'
```

***

### getValidators()

> `static` **getValidators**(`name`): `ValidatorFunction`[] \| `undefined`

Defined in: [packages/core/src/registry.ts:1265](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L1265)

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

Defined in: [packages/core/src/registry.ts:706](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L706)

Check if a class is registered (case-insensitive)

#### Parameters

##### name

`string`

#### Returns

`boolean`

***

### invalidateAllInheritanceCaches()

> `static` **invalidateAllInheritanceCaches**(): `void`

Defined in: [packages/core/src/registry.ts:764](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L764)

Invalidate all inheritance caches

Clears all cached inheritance chains and merged fields/methods.
Call this when multiple classes change at runtime.

#### Returns

`void`

#### Example

```typescript
// After hot module reload of multiple classes
ObjectRegistry.invalidateAllInheritanceCaches();
```

***

### invalidateInheritanceCache()

> `static` **invalidateInheritanceCache**(`className`): `void`

Defined in: [packages/core/src/registry.ts:733](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L733)

Invalidate inheritance cache for a specific class

Clears cached inheritance chain and merged fields/methods for the given class.
Call this when a class definition changes at runtime (e.g., hot module reload).

#### Parameters

##### className

`string`

The class name to invalidate cache for

#### Returns

`void`

#### Example

```typescript
// After hot module reload of a parent class
ObjectRegistry.invalidateInheritanceCache('BentleyContent');
```

***

### loadFromDatabase()

> `static` **loadFromDatabase**(`db`): `Promise`\<`any`[]\>

Defined in: [packages/core/src/registry.ts:2219](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L2219)

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

Defined in: [packages/core/src/registry.ts:2164](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L2164)

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

Defined in: [packages/core/src/registry.ts:344](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L344)

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

Defined in: [packages/core/src/registry.ts:530](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L530)

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

***

### registerFromManifest()

> `static` **registerFromManifest**(`name`, `objectDef`, `packageName?`): `void`

Defined in: [packages/core/src/registry.ts:560](https://github.com/happyvertical/smrt/blob/eace045cd33fc2d690bf2fd9ce922942574eb242/packages/core/src/registry.ts#L560)

Register an object from manifest metadata (for CLI/tools without importing actual classes)

This method allows tools like the CLI to register objects from build-time manifest data
without needing to import the actual class. This solves the bootstrap problem where
`npx smrt` can't access user project classes but needs to generate commands for them.

#### Parameters

##### name

`string`

Name of the object class

##### objectDef

`any`

Object definition from manifest

##### packageName?

`string`

Package name from manifest

#### Returns

`void`

#### Example

```typescript
const manifest = loadLocalTestManifestSync();
for (const [name, objectDef] of Object.entries(manifest.objects)) {
  ObjectRegistry.registerFromManifest(name, objectDef, manifest.packageName);
}
```
