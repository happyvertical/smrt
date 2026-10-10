# Consumer table bindings

A consumer can explicitly bind a dependency model to a different physical table
when its default table collides with an unrelated application model (#3660):

```ts
export default {
  smrt: {
    tableNames: {
      '@happyvertical/smrt-messages:Attachment': 'message_attachments',
    },
  },
};
```

Keys are exact, case-sensitive qualified model identities, not simple class
names or table names. Values are lowercase SQL identifiers of at most 63
characters. The application model's `attachments` table retains its original
schema, rows, and relationship targets; the messaging model uses
`message_attachments`. Dependencies and generated model registrations remain
present. Unrelated models mapped to the same table still fail the existing
ownership guard during both schema planning and runtime reads/writes. Valid
bindings for unregistered models stay dormant, so partial registries and
focused database fixtures do not need unrelated models. A later registration
activates its binding and ownership checks before storage access. Malformed
bindings fail even when their model is not yet registered.

Load the same `smrt.config` in every process before its first database access.
The SMRT CLI does this automatically. Programmatic hosts may use `loadConfig()`
or `setConfig({ smrt: { tableNames: ... } })` from `@happyvertical/smrt-config`.
Registration may happen before configuration, but bindings must not change
after objects or collections start using a database: instances cache their
physical table names. Changing or removing a configured binding after a table name was
cached fails closed and requires a restart. Ownership checks also run for
cached instances when later registrations reveal a conflict. A deployment's workers, web server, and migration process
must use identical bindings.

`ObjectRegistry.getSchema()`, model and collection storage, native DDL planning,
and same-package foreign-key targets share the binding. Index names are scoped
to the bound table. Published package manifests remain unchanged. Raw SQL in a
package must obtain table names from `ObjectRegistry.getTableName()`; literal
SQL table identifiers are outside this configuration contract. Before binding a
model, audit that package's custom SQL paths.

For single-table inheritance, bind the root model; its whole family follows it.
Binding a subtype independently is refused. Sensitive models cannot be rebound:
their published storage identity is part of change-feed disclosure protection.

A binding is **not a data migration**. Introducing a previously unused dependency
model creates its separate table through normal `smrt db:migrate`. Changing a
binding for an already deployed model requires an operator-authored data
migration and a coordinated restart. SMRT never guesses which existing rows
belong to the dependency, renames an application table, copies data, or drops
the old table in response to this setting. Preview with `smrt db:diff` before
applying it.
