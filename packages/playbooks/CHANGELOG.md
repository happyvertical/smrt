# @happyvertical/smrt-playbooks

## 0.55.7

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.55.7
  - @happyvertical/smrt-tenancy@0.55.7
  - @happyvertical/smrt-config@0.55.7
  - @happyvertical/smrt-types@0.55.7

## 0.55.6

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.55.6
  - @happyvertical/smrt-tenancy@0.55.6
  - @happyvertical/smrt-config@0.55.6
  - @happyvertical/smrt-types@0.55.6

## 0.55.5

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.55.5
  - @happyvertical/smrt-tenancy@0.55.5
  - @happyvertical/smrt-config@0.55.5
  - @happyvertical/smrt-types@0.55.5

## 0.55.4

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.55.4
  - @happyvertical/smrt-tenancy@0.55.4
  - @happyvertical/smrt-config@0.55.4
  - @happyvertical/smrt-types@0.55.4

## 0.55.3

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.55.3
  - @happyvertical/smrt-tenancy@0.55.3
  - @happyvertical/smrt-config@0.55.3
  - @happyvertical/smrt-types@0.55.3

## 0.55.2

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.55.2
  - @happyvertical/smrt-tenancy@0.55.2
  - @happyvertical/smrt-config@0.55.2
  - @happyvertical/smrt-types@0.55.2

## 0.55.1

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.55.1
  - @happyvertical/smrt-tenancy@0.55.1
  - @happyvertical/smrt-config@0.55.1
  - @happyvertical/smrt-types@0.55.1

## 0.55.0

### Patch Changes

- @happyvertical/smrt-config@0.55.0
  - @happyvertical/smrt-core@0.55.0
  - @happyvertical/smrt-tenancy@0.55.0
  - @happyvertical/smrt-types@0.55.0

## 0.54.4

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.54.4
  - @happyvertical/smrt-tenancy@0.54.4
  - @happyvertical/smrt-config@0.54.4
  - @happyvertical/smrt-types@0.54.4

## 0.54.3

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.54.3
  - @happyvertical/smrt-tenancy@0.54.3
  - @happyvertical/smrt-config@0.54.3
  - @happyvertical/smrt-types@0.54.3

## 0.54.2

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.54.2
  - @happyvertical/smrt-tenancy@0.54.2
  - @happyvertical/smrt-config@0.54.2
  - @happyvertical/smrt-types@0.54.2

## 0.54.1

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.54.1
  - @happyvertical/smrt-tenancy@0.54.1
  - @happyvertical/smrt-config@0.54.1
  - @happyvertical/smrt-types@0.54.1

## 0.54.0

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.54.0
  - @happyvertical/smrt-tenancy@0.54.0
  - @happyvertical/smrt-config@0.54.0
  - @happyvertical/smrt-types@0.54.0

## 0.53.6

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.53.6
  - @happyvertical/smrt-tenancy@0.53.6
  - @happyvertical/smrt-config@0.53.6
  - @happyvertical/smrt-types@0.53.6

## 0.53.5

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.53.5
  - @happyvertical/smrt-tenancy@0.53.5
  - @happyvertical/smrt-config@0.53.5
  - @happyvertical/smrt-types@0.53.5

## 0.53.4

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.53.4
  - @happyvertical/smrt-tenancy@0.53.4
  - @happyvertical/smrt-config@0.53.4
  - @happyvertical/smrt-types@0.53.4

## 0.53.3

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.53.3
  - @happyvertical/smrt-tenancy@0.53.3
  - @happyvertical/smrt-config@0.53.3
  - @happyvertical/smrt-types@0.53.3

## 0.53.2

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.53.2
  - @happyvertical/smrt-tenancy@0.53.2
  - @happyvertical/smrt-config@0.53.2
  - @happyvertical/smrt-types@0.53.2

## 0.53.1

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.53.1
  - @happyvertical/smrt-tenancy@0.53.1
  - @happyvertical/smrt-config@0.53.1
  - @happyvertical/smrt-types@0.53.1

## 0.53.0

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.53.0
  - @happyvertical/smrt-tenancy@0.53.0
  - @happyvertical/smrt-config@0.53.0
  - @happyvertical/smrt-types@0.53.0

## 0.52.0

### Minor Changes

- 0259083: `PromptOverride`, `PlaybookOverride`, `LanguageOverride` and `TenantKey` declare
  their `tenantId` as UUID, so it compares with every other `tenant_id` column.
  They stay deliberately not tenant-scoped. SQLite and DuckDB keep storing text.
  **On PostgreSQL run `smrt db:migrate-uuid`** to converge the existing text
  columns to native `uuid` (`db:status` reports them until then); a non-uuid
  value in those columns blocks the conversion and is reported with a sample.
  
  `@happyvertical/smrt-secrets`: an audit actor that is not a uuid (an email login
  identity, a service name) no longer fails the audit insert, and with it the
  audited operation: `secret_audit_logs.user_id` stores NULL and the raw actor is
  kept as `details.actorId`.

### Patch Changes

- Updated dependencies [0259083]
- Updated dependencies [0259083]
- Updated dependencies [0259083]
- Updated dependencies [0259083]
- Updated dependencies [0259083]
- Updated dependencies [0259083]
- Updated dependencies [0259083]
- Updated dependencies [0259083]
- Updated dependencies [0259083]
  - @happyvertical/smrt-core@0.52.0
  - @happyvertical/smrt-tenancy@0.52.0
  - @happyvertical/smrt-config@0.52.0
  - @happyvertical/smrt-types@0.52.0

## 0.51.39

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.51.39
  - @happyvertical/smrt-tenancy@0.51.39
  - @happyvertical/smrt-config@0.51.39
  - @happyvertical/smrt-types@0.51.39

## 0.51.38

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.51.38
  - @happyvertical/smrt-tenancy@0.51.38
  - @happyvertical/smrt-config@0.51.38
  - @happyvertical/smrt-types@0.51.38

## 0.51.37

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.51.37
  - @happyvertical/smrt-tenancy@0.51.37
  - @happyvertical/smrt-config@0.51.37
  - @happyvertical/smrt-types@0.51.37

## 0.51.36

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.51.36
  - @happyvertical/smrt-tenancy@0.51.36
  - @happyvertical/smrt-config@0.51.36
  - @happyvertical/smrt-types@0.51.36

## 0.51.35

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.51.35
  - @happyvertical/smrt-tenancy@0.51.35
  - @happyvertical/smrt-config@0.51.35
  - @happyvertical/smrt-types@0.51.35

## 0.51.34

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.51.34
  - @happyvertical/smrt-tenancy@0.51.34
  - @happyvertical/smrt-config@0.51.34
  - @happyvertical/smrt-types@0.51.34

## 0.51.33

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.51.33
  - @happyvertical/smrt-tenancy@0.51.33
  - @happyvertical/smrt-config@0.51.33
  - @happyvertical/smrt-types@0.51.33

## 0.51.32

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.51.32
  - @happyvertical/smrt-tenancy@0.51.32
  - @happyvertical/smrt-config@0.51.32
  - @happyvertical/smrt-types@0.51.32

## 0.51.31

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.51.31
  - @happyvertical/smrt-tenancy@0.51.31
  - @happyvertical/smrt-config@0.51.31
  - @happyvertical/smrt-types@0.51.31

## 0.51.30

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.51.30
  - @happyvertical/smrt-tenancy@0.51.30
  - @happyvertical/smrt-config@0.51.30
  - @happyvertical/smrt-types@0.51.30

## 0.51.29

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.51.29
  - @happyvertical/smrt-tenancy@0.51.29
  - @happyvertical/smrt-config@0.51.29
  - @happyvertical/smrt-types@0.51.29

## 0.51.28

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.51.28
  - @happyvertical/smrt-tenancy@0.51.28
  - @happyvertical/smrt-config@0.51.28
  - @happyvertical/smrt-types@0.51.28

## 0.51.27

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.51.27
  - @happyvertical/smrt-tenancy@0.51.27
  - @happyvertical/smrt-config@0.51.27
  - @happyvertical/smrt-types@0.51.27

## 0.51.26

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.51.26
  - @happyvertical/smrt-tenancy@0.51.26
  - @happyvertical/smrt-config@0.51.26
  - @happyvertical/smrt-types@0.51.26

## 0.51.25

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.51.25
  - @happyvertical/smrt-tenancy@0.51.25
  - @happyvertical/smrt-config@0.51.25
  - @happyvertical/smrt-types@0.51.25

## 0.51.24

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.51.24
  - @happyvertical/smrt-tenancy@0.51.24
  - @happyvertical/smrt-config@0.51.24
  - @happyvertical/smrt-types@0.51.24

## 0.51.23

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.51.23
  - @happyvertical/smrt-tenancy@0.51.23
  - @happyvertical/smrt-config@0.51.23
  - @happyvertical/smrt-types@0.51.23

## 0.51.22

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.51.22
  - @happyvertical/smrt-tenancy@0.51.22
  - @happyvertical/smrt-config@0.51.22
  - @happyvertical/smrt-types@0.51.22

## 0.51.21

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.51.21
  - @happyvertical/smrt-tenancy@0.51.21
  - @happyvertical/smrt-config@0.51.21
  - @happyvertical/smrt-types@0.51.21

## 0.51.20

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.51.20
  - @happyvertical/smrt-tenancy@0.51.20
  - @happyvertical/smrt-config@0.51.20
  - @happyvertical/smrt-types@0.51.20

## 0.51.19

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.51.19
  - @happyvertical/smrt-tenancy@0.51.19
  - @happyvertical/smrt-config@0.51.19
  - @happyvertical/smrt-types@0.51.19

## 0.51.18

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.51.18
  - @happyvertical/smrt-tenancy@0.51.18
  - @happyvertical/smrt-config@0.51.18
  - @happyvertical/smrt-types@0.51.18

## 0.51.17

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.51.17
  - @happyvertical/smrt-tenancy@0.51.17
  - @happyvertical/smrt-config@0.51.17
  - @happyvertical/smrt-types@0.51.17

## 0.51.16

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.51.16
  - @happyvertical/smrt-tenancy@0.51.16
  - @happyvertical/smrt-config@0.51.16
  - @happyvertical/smrt-types@0.51.16

## 0.51.15

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.51.15
  - @happyvertical/smrt-tenancy@0.51.15
  - @happyvertical/smrt-config@0.51.15
  - @happyvertical/smrt-types@0.51.15

## 0.51.14

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.51.14
  - @happyvertical/smrt-tenancy@0.51.14
  - @happyvertical/smrt-config@0.51.14
  - @happyvertical/smrt-types@0.51.14

## 0.51.13

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.51.13
  - @happyvertical/smrt-tenancy@0.51.13
  - @happyvertical/smrt-config@0.51.13
  - @happyvertical/smrt-types@0.51.13

## 0.51.12

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.51.12
  - @happyvertical/smrt-tenancy@0.51.12
  - @happyvertical/smrt-config@0.51.12
  - @happyvertical/smrt-types@0.51.12

## 0.51.11

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.51.11
  - @happyvertical/smrt-tenancy@0.51.11
  - @happyvertical/smrt-config@0.51.11
  - @happyvertical/smrt-types@0.51.11

## 0.51.10

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.51.10
  - @happyvertical/smrt-tenancy@0.51.10
  - @happyvertical/smrt-config@0.51.10
  - @happyvertical/smrt-types@0.51.10

## 0.51.9

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.51.9
  - @happyvertical/smrt-tenancy@0.51.9
  - @happyvertical/smrt-config@0.51.9
  - @happyvertical/smrt-types@0.51.9

## 0.51.8

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.51.8
  - @happyvertical/smrt-tenancy@0.51.8
  - @happyvertical/smrt-config@0.51.8
  - @happyvertical/smrt-types@0.51.8

## 0.51.7

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.51.7
  - @happyvertical/smrt-tenancy@0.51.7
  - @happyvertical/smrt-config@0.51.7
  - @happyvertical/smrt-types@0.51.7

## 0.51.6

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.51.6
  - @happyvertical/smrt-tenancy@0.51.6
  - @happyvertical/smrt-config@0.51.6
  - @happyvertical/smrt-types@0.51.6

## 0.51.5

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.51.5
  - @happyvertical/smrt-tenancy@0.51.5
  - @happyvertical/smrt-config@0.51.5
  - @happyvertical/smrt-types@0.51.5

## 0.51.4

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.51.4
  - @happyvertical/smrt-tenancy@0.51.4
  - @happyvertical/smrt-config@0.51.4
  - @happyvertical/smrt-types@0.51.4

## 0.51.3

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.51.3
  - @happyvertical/smrt-tenancy@0.51.3
  - @happyvertical/smrt-config@0.51.3
  - @happyvertical/smrt-types@0.51.3

## 0.51.2

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.51.2
  - @happyvertical/smrt-tenancy@0.51.2
  - @happyvertical/smrt-config@0.51.2
  - @happyvertical/smrt-types@0.51.2

## 0.51.1

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.51.1
  - @happyvertical/smrt-tenancy@0.51.1
  - @happyvertical/smrt-config@0.51.1
  - @happyvertical/smrt-types@0.51.1

## 1.0.0

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@1.0.0
  - @happyvertical/smrt-tenancy@1.0.0
  - @happyvertical/smrt-config@1.0.0
  - @happyvertical/smrt-types@1.0.0

## 0.49.8

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.49.8
  - @happyvertical/smrt-tenancy@0.49.8
  - @happyvertical/smrt-config@0.49.8
  - @happyvertical/smrt-types@0.49.8

## 0.49.7

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.49.7
  - @happyvertical/smrt-tenancy@0.49.7
  - @happyvertical/smrt-config@0.49.7
  - @happyvertical/smrt-types@0.49.7

## 0.49.6

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.49.6
  - @happyvertical/smrt-tenancy@0.49.6
  - @happyvertical/smrt-config@0.49.6
  - @happyvertical/smrt-types@0.49.6

## 0.49.5

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.49.5
  - @happyvertical/smrt-tenancy@0.49.5
  - @happyvertical/smrt-config@0.49.5
  - @happyvertical/smrt-types@0.49.5

## 0.49.4

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.49.4
  - @happyvertical/smrt-tenancy@0.49.4
  - @happyvertical/smrt-config@0.49.4
  - @happyvertical/smrt-types@0.49.4

## 0.49.3

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.49.3
  - @happyvertical/smrt-tenancy@0.49.3
  - @happyvertical/smrt-config@0.49.3
  - @happyvertical/smrt-types@0.49.3

## 0.49.2

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.49.2
  - @happyvertical/smrt-tenancy@0.49.2
  - @happyvertical/smrt-config@0.49.2
  - @happyvertical/smrt-types@0.49.2

## 0.49.1

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.49.1
  - @happyvertical/smrt-tenancy@0.49.1
  - @happyvertical/smrt-config@0.49.1
  - @happyvertical/smrt-types@0.49.1

## 1.0.0

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@1.0.0
  - @happyvertical/smrt-tenancy@1.0.0
  - @happyvertical/smrt-config@1.0.0
  - @happyvertical/smrt-types@1.0.0

## 1.0.0

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@1.0.0
  - @happyvertical/smrt-tenancy@1.0.0
  - @happyvertical/smrt-config@1.0.0
  - @happyvertical/smrt-types@1.0.0

## 0.47.2

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.47.2
  - @happyvertical/smrt-tenancy@0.47.2
  - @happyvertical/smrt-config@0.47.2
  - @happyvertical/smrt-types@0.47.2

## 0.47.1

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.47.1
  - @happyvertical/smrt-tenancy@0.47.1
  - @happyvertical/smrt-config@0.47.1
  - @happyvertical/smrt-types@0.47.1

## 1.0.0

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@1.0.0
  - @happyvertical/smrt-tenancy@1.0.0
  - @happyvertical/smrt-config@1.0.0
  - @happyvertical/smrt-types@1.0.0

## 1.0.0

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@1.0.0
  - @happyvertical/smrt-tenancy@1.0.0
  - @happyvertical/smrt-config@1.0.0
  - @happyvertical/smrt-types@1.0.0

## 0.45.3

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.45.3
  - @happyvertical/smrt-tenancy@0.45.3
  - @happyvertical/smrt-config@0.45.3
  - @happyvertical/smrt-types@0.45.3

## 0.45.2

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.45.2
  - @happyvertical/smrt-tenancy@0.45.2
  - @happyvertical/smrt-config@0.45.2
  - @happyvertical/smrt-types@0.45.2

## 0.45.1

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@0.45.1
  - @happyvertical/smrt-tenancy@0.45.1
  - @happyvertical/smrt-config@0.45.1
  - @happyvertical/smrt-types@0.45.1

## 1.0.0

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@1.0.0
  - @happyvertical/smrt-tenancy@1.0.0
  - @happyvertical/smrt-config@1.0.0
  - @happyvertical/smrt-types@1.0.0

## 1.0.0

### Patch Changes

- Updated dependencies
  - @happyvertical/smrt-core@1.0.0
  - @happyvertical/smrt-tenancy@1.0.0
  - @happyvertical/smrt-config@1.0.0
  - @happyvertical/smrt-types@1.0.0
