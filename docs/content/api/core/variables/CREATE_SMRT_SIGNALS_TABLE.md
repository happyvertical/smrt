# Variable: CREATE\_SMRT\_SIGNALS\_TABLE

> `const` **CREATE\_SMRT\_SIGNALS\_TABLE**: "\nCREATE TABLE IF NOT EXISTS \_smrt\_signals (\n  id TEXT PRIMARY KEY,\n  type TEXT NOT NULL,\n  source\_class TEXT,\n  source\_id TEXT,\n  target\_class TEXT,\n  target\_id TEXT,\n  payload TEXT,\n  timestamp DATETIME DEFAULT CURRENT\_TIMESTAMP\n);\n\nCREATE INDEX IF NOT EXISTS idx\_smrt\_signals\_source\n  ON \_smrt\_signals(source\_class, source\_id);\n\nCREATE INDEX IF NOT EXISTS idx\_smrt\_signals\_type\n  ON \_smrt\_signals(type);\n\nCREATE INDEX IF NOT EXISTS idx\_smrt\_signals\_timestamp\n  ON \_smrt\_signals(timestamp);\n"

Defined in: smrt/packages/core/src/system/schema.ts:79

Signal history/audit log
Optional persistence of signals for debugging and auditing
