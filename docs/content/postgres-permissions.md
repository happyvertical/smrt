---
title: PostgreSQL deployment permissions
---

# PostgreSQL deployment permissions

SMRT separates PostgreSQL migration ownership from runtime access through a
declarative permission contract. Infrastructure provisions databases, roles,
credentials, and connection settings. SMRT plans, reconciles, and verifies
permissions on the declared framework/application schema. These database
privileges are separate from application authorization, tenant isolation, and
row-level security.

## Consumer setup

Use PostgreSQL 14 or later, a schema dedicated to this application, and a
migration owner that creates its objects. Runtime and optional monitoring roles
must be separate identities.
The permission operation does not create roles or change passwords, login
settings, memberships, database ownership, or deployment wiring.

Declare role names and optional monitoring columns in `smrt.config.ts`:

```ts
export default {
  smrt: {
    postgresPermissions: {
      schema: 'public',
      schemaExclusive: true,
      migrationOwner: 'app_migrator',
      runtimeRole: 'app_runtime',
      monitor: {
        role: 'app_monitor',
        tables: {
          source_crawls: ['status', 'started_at', 'finished_at'],
        },
      },
    },
  },
};
```

`schemaExclusive: true` acknowledges that creator-specific future-object
defaults apply to the entire named schema. Do not use a shared schema containing
unrelated objects. Monitoring declarations are application-owned; SMRT does not
embed consumer table names. Undeclared monitoring columns and future tables are
not granted.

The CLI discovers model tables from the application registry and includes
present framework system tables. Add `managedTables: ['additional_table']` for
application-managed tables outside that registry. Declared tables and monitoring
columns must already exist. `packages.cli.postgresPermissions` can override the
global contract using the normal package configuration precedence.

## Plan, apply, verify

Stop runtime and monitoring sessions for the complete migration or restore,
permission-reconciliation, and verification cycle. Resume them only after the
checks below pass. Run supported migrations as the migration owner before
reconciling permissions.
Use the configured PostgreSQL connection for these operator commands. Keep
connection secrets in the deployment's existing secret configuration; the
permission contract contains role identifiers only.

Apply as the declared migration owner or a PostgreSQL superuser, using the same
database identity that generated the plan. Pause concurrent migrations and ACL
administration while reviewing and applying it. The operation serializes other
SMRT permission writers; it cannot fence independent PostgreSQL administrators.

```sh
smrt db:migrate
smrt db:permissions --dry-run
smrt db:permissions --apply --expected-fingerprint <reviewed-fingerprint>
smrt db:validate
smrt doctor --db
```

`db:permissions` defaults to a read-only plan. Review its SQL statements,
diagnostics, and fingerprint before applying it. A stale fingerprint refuses
execution; obtain and review a new plan after a catalog or contract change.
`--json` provides machine-readable output. Ordinary migrations, `db:validate`,
and `doctor --db` never repair PostgreSQL permissions automatically.

Runtime receives application DML without ownership or DDL authority; the monitor
receives only its declared column reads. Diagnostics distinguish missing,
excessive, and unsupported privilege sources. A refusal is not a healthy result:
follow its prerequisite or infrastructure-remediation explanation, then rerun
the read-only check. Diagnostics inspect catalogs, not application records.

## Schema evolution and recovery

Defaults belong to the role that actually creates an object. Run migrations as
the declared migration owner, then review and reconcile permissions after each
migration or restore. Existing objects, historical column grants, and global
defaults must be assessed as well as schema-local defaults. Monitoring access
does not automatically expand when columns or tables are added.

The migration bookkeeping tables `_smrt_migrations`, `_smrt_schema_migrations`,
and `_smrt_backfills` must already exist before permission setup can succeed.
Their runtime access is SELECT-only. PostgreSQL defaults cannot distinguish
table names: dropping and recreating one of those tables would temporarily
inherit the future-table DML grants. Never recreate bookkeeping tables while
runtime or monitor sessions are active. After a restore or recreation, keep
those sessions stopped until explicit reconciliation restores the restricted
grants and diagnostics pass. Online migration/restore with active restricted
sessions is outside this permission contract.

Future-object qualification covers tables and sequences. PostgreSQL implicitly
grants PUBLIC execution of new routines and usage of new types unless global
creator defaults say otherwise; this schema-scoped operation does not revoke
those global privileges. Plans report that limitation explicitly. User-defined
routines and types require separate review and produce unsupported diagnostics;
table-backed row types are not standalone types. Rerun diagnostics after every
migration and before enabling runtime access. Row-level security policies and
views are also outside this ACL contract.

PostgreSQL documents the creator-specific and additive behavior in
[ALTER DEFAULT PRIVILEGES](https://www.postgresql.org/docs/17/sql-alterdefaultprivileges.html)
and the ownership/PUBLIC rules in
[Privileges](https://www.postgresql.org/docs/17/ddl-priv.html).

Permission application uses one transaction and verifies the result before
commit. A failed statement or failed verification rolls back the permission
changes. Correct the reported prerequisite and generate a fresh plan; do not
reuse a fingerprint from before the failure without rechecking. Repeated
execution against an unchanged converged contract is a no-op.

Memberships, privileged role attributes, ownership, PUBLIC grants, and unsupported
objects can confer access that direct table grants cannot safely remove. Such
cases fail closed instead of revoking unrelated permissions or declaring the
roles safe. Infrastructure must resolve privilege sources outside the supported
remediation scope before retrying.

For example, PUBLIC `TEMPORARY` on the database must be removed by infrastructure
before a runtime-without-temporary-tables contract can pass. Direct PostgreSQL
parameter privileges such as `ALTER SYSTEM` also require infrastructure review;
SMRT never revokes global parameter authority as part of schema repair.

## Deployment qualification

Qualify a restored disposable database using the exact released application and
SMRT versions. Exercise runtime reads/writes and denied DDL, monitor allowed and
denied columns, repeat application, future migrations, and rollback before
changing production deployment wiring.

For the Iolaus migration tracked by SMRT #2701, releasing the framework mechanism
is a prerequisite for replacing and requalifying the dormant workaround in
happyvertical/iac#1698. The SMRT pull request does not activate that Job, enable
runtime logins, or approve production writes/cutover. Those remain separate
downstream deployment steps under willgriffin/iolaus#33.
