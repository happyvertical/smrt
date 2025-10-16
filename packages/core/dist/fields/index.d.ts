/**
 * Field definition system for SMRT objects
 *
 * Provides a clean, type-safe field definition syntax inspired by modern ORMs.
 * Fields define database schema, validation rules, and TypeScript types automatically.
 *
 * @example Basic field usage
 * ```typescript
 * import { text, decimal, boolean, foreignKey } from '@smrt/core/fields';
 *
 * class Product extends SmrtObject {
 *   name = text({ required: true, maxLength: 100 });
 *   price = decimal({ min: 0, max: 999999.99 });
 *   active = boolean({ default: true });
 *   categoryId = foreignKey(Category, { onDelete: 'restrict' });
 * }
 * ```
 *
 * @example Advanced field configuration
 * ```typescript
 * class User extends SmrtObject {
 *   email = text({
 *     required: true,
 *     unique: true,
 *     pattern: '^[^@]+@[^@]+\.[^@]+$',
 *     description: 'User email address'
 *   });
 *   metadata = json({ default: {} });
 *   createdAt = datetime({ required: true });
 * }
 * ```
 */
/**
 * Base configuration options available for all field types
 *
 * @interface FieldOptions
 */
export interface FieldOptions {
    /** Whether this field is the primary key (default: false, 'id' field is auto-generated) */
    primaryKey?: boolean;
    /** Whether this field is required (NOT NULL constraint) */
    required?: boolean;
    /** Default value for this field when creating new objects */
    default?: any;
    /** Whether this field must have unique values (UNIQUE constraint) */
    unique?: boolean;
    /** Whether to create a database index on this field for faster queries */
    index?: boolean;
    /** Human-readable description of the field's purpose */
    description?: string;
    /**
     * Custom validation function (synchronous or asynchronous)
     * Should return true if valid, false if invalid
     * @param value - The field value to validate
     * @returns Boolean indicating validity
     * @example
     * ```typescript
     * email = text({
     *   validate: (v) => /^[^@]+@[^@]+\.[^@]+$/.test(v),
     *   customMessage: 'Invalid email format'
     * });
     * ```
     */
    validate?: (value: any) => boolean | Promise<boolean>;
    /**
     * Custom error message to display when validation fails
     * Works with both built-in validators and custom validate functions
     */
    customMessage?: string;
}
/**
 * Configuration options for numeric fields (integer, decimal)
 *
 * @interface NumericFieldOptions
 * @extends FieldOptions
 */
export interface NumericFieldOptions extends FieldOptions {
    /** Minimum allowed value for this field */
    min?: number;
    /** Maximum allowed value for this field */
    max?: number;
}
/**
 * Configuration options for text fields
 *
 * @interface TextFieldOptions
 * @extends FieldOptions
 */
export interface TextFieldOptions extends FieldOptions {
    /** Maximum length in characters */
    maxLength?: number;
    /** Minimum length in characters */
    minLength?: number;
    /** Regular expression pattern for validation */
    pattern?: string;
    /** Whether to encrypt this field's value in storage */
    encrypted?: boolean;
}
/**
 * Configuration options for relationship fields (foreign keys, associations)
 *
 * @interface RelationshipFieldOptions
 * @extends FieldOptions
 */
export interface RelationshipFieldOptions extends FieldOptions {
    /** What to do when the referenced object is deleted */
    onDelete?: 'cascade' | 'restrict' | 'set_null';
    /** Name of the related class (automatically set by relationship functions) */
    related?: string;
}
/**
 * Base field class that all field types extend
 *
 * Represents a database field with type information, validation rules,
 * and SQL generation capabilities. All field functions return instances
 * of this class with specific type and options configurations.
 *
 * @class Field
 */
export declare class Field {
    readonly type: string;
    readonly options: FieldOptions;
    value: any;
    constructor(type: string, options?: FieldOptions);
    /**
     * String coercion - allows Field instances to be used naturally in string contexts
     * @returns String representation of the field's value
     * @example
     * ```typescript
     * const name = text({ default: 'John' });
     * console.log(name.toLowerCase()); // 'john' - toString() called automatically
     * ```
     */
    toString(): string;
    /**
     * Value coercion - returns the actual value for comparisons and operations
     * @returns The field's value
     * @example
     * ```typescript
     * const age = integer({ default: 25 });
     * console.log(age + 5); // 30 - valueOf() called automatically
     * ```
     */
    valueOf(): any;
    /**
     * JSON serialization - returns the value for JSON.stringify()
     * @returns The field's value for JSON serialization
     * @example
     * ```typescript
     * const data = { name: text({ default: 'John' }) };
     * JSON.stringify(data); // {"name":"John"} - toJSON() called automatically
     * ```
     */
    toJSON(): any;
    /**
     * Get the SQL type for this field based on the field type
     *
     * @returns SQL type string (e.g., 'TEXT', 'INTEGER', 'REAL')
     * @example
     * ```typescript
     * const nameField = text();
     * console.log(nameField.getSqlType()); // 'TEXT'
     * ```
     */
    getSqlType(): string;
    /**
     * Get field constraints for SQL DDL statements
     *
     * @returns Array of SQL constraint strings (e.g., ['NOT NULL', 'UNIQUE', 'PRIMARY KEY'])
     * @example
     * ```typescript
     * const emailField = text({ required: true, unique: true });
     * console.log(emailField.getSqlConstraints()); // ['NOT NULL', 'UNIQUE']
     *
     * const slugField = text({ primaryKey: true });
     * console.log(slugField.getSqlConstraints()); // ['PRIMARY KEY']
     * ```
     */
    getSqlConstraints(): string[];
    /**
     * Escapes a value for safe inclusion in SQL statements
     *
     * @param value - Value to escape
     * @returns Escaped SQL value string
     * @private
     */
    private escapeSqlValue;
}
/**
 * Creates a text field for storing string values
 *
 * @param options - Configuration options for the text field
 * @returns Field instance configured for text storage
 * @example
 * ```typescript
 * class User extends SmrtObject {
 *   name = text({ required: true, maxLength: 100 });
 *   email = text({ unique: true, pattern: '^[^@]+@[^@]+\.[^@]+$' });
 *   bio = text({ maxLength: 500 });
 * }
 * ```
 */
export declare function text(options?: TextFieldOptions): Field;
/**
 * Creates an integer field for storing whole numbers
 *
 * @param options - Configuration options for the integer field
 * @returns Field instance configured for integer storage
 * @example
 * ```typescript
 * class Product extends SmrtObject {
 *   quantity = integer({ min: 0, required: true });
 *   rating = integer({ min: 1, max: 5 });
 *   views = integer({ default: 0 });
 * }
 * ```
 */
export declare function integer(options?: NumericFieldOptions): Field;
/**
 * Creates a decimal field for storing floating point numbers
 *
 * @param options - Configuration options for the decimal field
 * @returns Field instance configured for decimal storage
 * @example
 * ```typescript
 * class Product extends SmrtObject {
 *   price = decimal({ min: 0, required: true });
 *   weight = decimal({ min: 0.01, max: 999.99 });
 *   discountRate = decimal({ min: 0, max: 1, default: 0 });
 * }
 * ```
 */
export declare function decimal(options?: NumericFieldOptions): Field;
/**
 * Creates a boolean field for storing true/false values
 *
 * @param options - Configuration options for the boolean field
 * @returns Field instance configured for boolean storage
 * @example
 * ```typescript
 * class User extends SmrtObject {
 *   isActive = boolean({ default: true });
 *   hasVerifiedEmail = boolean({ default: false });
 *   isAdmin = boolean({ required: true });
 * }
 * ```
 */
export declare function boolean(options?: FieldOptions): Field;
/**
 * Creates a datetime field for storing timestamps
 *
 * @param options - Configuration options for the datetime field
 * @returns Field instance configured for datetime storage
 * @example
 * ```typescript
 * class Event extends SmrtObject {
 *   startDate = datetime({ required: true });
 *   endDate = datetime();
 *   createdAt = datetime({ default: new Date() });
 * }
 * ```
 */
export declare function datetime(options?: FieldOptions): Field;
/**
 * Creates a JSON field for storing structured data objects
 *
 * @param options - Configuration options for the JSON field
 * @returns Field instance configured for JSON storage
 * @example
 * ```typescript
 * class User extends SmrtObject {
 *   preferences = json({ default: {} });
 *   metadata = json();
 *   config = json({ required: true });
 * }
 * ```
 */
export declare function json(options?: FieldOptions): Field;
/**
 * Creates a foreign key field that references another SMRT object
 *
 * Supports lazy string-based references to avoid circular dependencies:
 * - String: `foreignKey('Customer')` - Recommended, avoids circular deps
 * - Function: `foreignKey(() => Customer)` - Lazy evaluation
 * - Class: `foreignKey(Customer)` - Direct reference (legacy, can cause circular deps)
 *
 * @param relatedClass - String name, lazy function, or class constructor of the related object
 * @param options - Configuration options for the foreign key field
 * @returns Field instance configured for foreign key relationships
 * @example
 * ```typescript
 * class Order extends SmrtObject {
 *   // Recommended: Lazy string reference (no circular dependency)
 *   customerId = foreignKey('Customer', { required: true, onDelete: 'restrict' });
 *   productId = foreignKey('Product', { onDelete: 'cascade' });
 *
 *   // Alternative: Lazy function reference
 *   categoryId = foreignKey(() => Category, { required: true });
 *
 *   // Legacy: Direct class reference (can cause circular dependency issues)
 *   // customerId = foreignKey(Customer, { required: true });
 * }
 * ```
 */
export declare function foreignKey(relatedClass: string | Function | any, options?: Omit<RelationshipFieldOptions, 'related'>): Field;
/**
 * Creates a one-to-many relationship field
 *
 * Supports lazy string-based references to avoid circular dependencies:
 * - String: `oneToMany('Product')` - Recommended, avoids circular deps
 * - Function: `oneToMany(() => Product)` - Lazy evaluation
 * - Class: `oneToMany(Product)` - Direct reference (legacy, can cause circular deps)
 *
 * @param relatedClass - String name, lazy function, or class constructor of the related objects
 * @param options - Configuration options for the relationship
 * @returns Field instance configured for one-to-many relationships
 * @example
 * ```typescript
 * class Category extends SmrtObject {
 *   // Recommended: Lazy string reference
 *   products = oneToMany('Product');
 * }
 *
 * class Customer extends SmrtObject {
 *   orders = oneToMany('Order', { onDelete: 'cascade' });
 * }
 * ```
 */
export declare function oneToMany(relatedClass: string | Function | any, options?: Omit<RelationshipFieldOptions, 'related'>): Field;
/**
 * Creates a many-to-many relationship field
 *
 * Supports lazy string-based references to avoid circular dependencies:
 * - String: `manyToMany('Category')` - Recommended, avoids circular deps
 * - Function: `manyToMany(() => Category)` - Lazy evaluation
 * - Class: `manyToMany(Category)` - Direct reference (legacy, can cause circular deps)
 *
 * @param relatedClass - String name, lazy function, or class constructor of the related objects
 * @param options - Configuration options for the relationship
 * @returns Field instance configured for many-to-many relationships
 * @example
 * ```typescript
 * class Product extends SmrtObject {
 *   // Recommended: Lazy string references
 *   categories = manyToMany('Category');
 *   tags = manyToMany('Tag');
 * }
 *
 * class User extends SmrtObject {
 *   roles = manyToMany('Role');
 * }
 * ```
 */
export declare function manyToMany(relatedClass: string | Function | any, options?: Omit<RelationshipFieldOptions, 'related'>): Field;
//# sourceMappingURL=index.d.ts.map