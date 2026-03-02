## SMRT Source Patterns

### @smrt() Decorator
- Always on a class extending SmrtObject
- `api`, `mcp`, `cli` control code generation exposure (can be boolean or `{ include: [...] }`)
- `tableStrategy: 'sti'` for single-table inheritance; child classes inherit the setting
- `conflictColumns` for upsert natural keys — required on junction tables
- `tenantScoped: true` or use `@TenantScoped()` decorator from smrt-tenancy

### Field Conventions
- Plain TypeScript types preferred: `name: string = ''`, `count: number = 0`
- INTEGER: `= 0` (no decimal). DECIMAL: `= 0.0` (has decimal point)
- Use field helpers only for: `foreignKey(Class)`, `text({ required: true })`, `decimal({ nullable: true })`
- `@meta()` for STI child-specific fields — stored in `_meta_data` JSONB column, not as table columns
- `@tenantId({ nullable: true })` for optional tenant scoping

### Critical Rules
- Never override `toJSON()` — use `transformJSON()` instead (toJSON handles STI discriminator + meta field extraction)
- Cross-package references: plain string IDs, not `@foreignKey()` (avoids circular dependency)
- System tables: prefix with `_smrt_`
- JSON fields: store as string, provide `getX()`/`setX()` helpers with `try/catch` around JSON.parse
- Metadata pattern: `metadata: Record<string, any> = {}` with get/set/update helpers
- `@field({ transient: true })` for computed properties that shouldn't be persisted
