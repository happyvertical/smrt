# Variable: CREATE\_SMRT\_MIGRATIONS\_TABLE

> `const` **CREATE\_SMRT\_MIGRATIONS\_TABLE**: "\nCREATE TABLE IF NOT EXISTS \_smrt\_migrations (\n  id TEXT PRIMARY KEY,\n  version TEXT NOT NULL UNIQUE,\n  applied\_at DATETIME DEFAULT CURRENT\_TIMESTAMP,\n  description TEXT,\n  checksum TEXT\n);\n"

Defined in: smrt/packages/core/src/system/schema.ts:49

Schema version tracking
Records which SMRT framework versions have been applied
