---
"@happyvertical/smrt-cli": minor
---

feat(cli): add db:setup command for database initialization

Adds `smrt db:setup` command to initialize database schema for all registered SMRT objects.

**Features:**
- Reads database configuration from `smrt.config.js`
- Auto-discovers SMRT objects and generates schema
- Respects initialization order (foreign key dependencies)
- Handles STI (Single Table Inheritance) hierarchies correctly
- `--dry-run` flag to preview SQL without executing
- `--drop` flag to drop existing tables before creating (with interactive confirmation)
- `--verbose` flag for detailed output

**Requirements:**
- Requires explicit database configuration in `smrt.config.js` (cannot use `:memory:`)
- Prompts for confirmation when using `--drop` in interactive mode
- Fails in non-interactive mode with `--drop` flag (safety measure)

**Examples:**
```bash
# Basic usage - create all tables
smrt db:setup

# Preview SQL without executing
smrt db:setup --dry-run

# Drop and recreate all tables (prompts for confirmation)
smrt db:setup --drop

# Verbose output with detailed logging
smrt db:setup --verbose
```

**Use Cases:**
- Initial database setup for new projects
- Resetting development database
- Previewing schema changes with --dry-run
- CI/CD pipeline database initialization

**Error Handling:**
- Validates database configuration exists
- Fails gracefully with missing manifests
- Continues on individual table errors (shows ✗ but doesn't stop)
- Shows helpful error messages with fix suggestions
