# Variable: CREATE\_SMRT\_REGISTRY\_TABLE

> `const` **CREATE\_SMRT\_REGISTRY\_TABLE**: "\nCREATE TABLE IF NOT EXISTS \_smrt\_registry (\n  class\_name TEXT PRIMARY KEY,\n  schema\_version TEXT,\n  fields TEXT,\n  relationships TEXT,\n  config TEXT,\n  manifest TEXT,\n  last\_updated DATETIME DEFAULT CURRENT\_TIMESTAMP\n);\n"

Defined in: [smrt/packages/core/src/system/schema.ts:63](https://github.com/happyvertical/smrt/blob/3e10e04571f8229dee5c87ee2f9b9b06c6c49f12/packages/core/src/system/schema.ts#L63)

Runtime object registry persistence
Stores metadata about registered SMRT objects for introspection
