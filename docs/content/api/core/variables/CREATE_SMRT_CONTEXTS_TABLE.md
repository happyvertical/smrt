# Variable: CREATE\_SMRT\_CONTEXTS\_TABLE

> `const` **CREATE\_SMRT\_CONTEXTS\_TABLE**: "\nCREATE TABLE IF NOT EXISTS \_smrt\_contexts (\n  id TEXT PRIMARY KEY,\n  owner\_class TEXT NOT NULL,\n  owner\_id TEXT NOT NULL,\n  scope TEXT NOT NULL,\n  key TEXT NOT NULL,\n  value TEXT,\n  metadata TEXT,\n  version INTEGER DEFAULT 1,\n  confidence REAL DEFAULT 1.0,\n  success\_count INTEGER DEFAULT 0,\n  failure\_count INTEGER DEFAULT 0,\n  created\_at DATETIME DEFAULT CURRENT\_TIMESTAMP,\n  updated\_at DATETIME DEFAULT CURRENT\_TIMESTAMP,\n  last\_used\_at DATETIME,\n  expires\_at DATETIME,\n  UNIQUE(owner\_class, owner\_id, scope, key, version)\n);\n\nCREATE INDEX IF NOT EXISTS idx\_smrt\_contexts\_owner\n  ON \_smrt\_contexts(owner\_class, owner\_id);\n\nCREATE INDEX IF NOT EXISTS idx\_smrt\_contexts\_scope\n  ON \_smrt\_contexts(scope);\n\nCREATE INDEX IF NOT EXISTS idx\_smrt\_contexts\_confidence\n  ON \_smrt\_contexts(confidence);\n\nCREATE INDEX IF NOT EXISTS idx\_smrt\_contexts\_last\_used\n  ON \_smrt\_contexts(last\_used\_at);\n"

Defined in: smrt/packages/core/src/system/schema.ts:12

Context memory storage
Stores remembered context (learned strategies, patterns, selectors) for reuse
