# @happyvertical/smrt-config

## 0.18.2

## 0.18.1

## 1.0.0

## 0.17.100

## 0.17.99

## 0.17.98

## 0.17.97

## 0.17.96

## 0.17.95

## 0.17.94

## 0.17.93

## 0.17.92

## 0.17.91

## 0.17.90

## 0.17.89

## 0.17.88

## 0.17.87

## 0.17.86

## 0.17.85

## 0.17.84

## 0.17.83

## 0.17.82

## 0.17.81

## 0.17.80

## 0.17.79

## 0.17.78

## 0.17.77

## 0.17.76

## 0.17.75

## 0.17.74

## 0.17.73

## 0.17.72

## 0.17.71

## 0.17.70

## 0.17.69

## 0.17.68

## 0.17.67

## 0.17.66

## 0.17.65

## 0.17.64

## 0.17.63

## 0.17.62

## 0.17.61

## 0.17.60

## 0.17.59

## 0.17.58

## 0.17.57

## 0.17.56

## 0.17.55

## 0.17.54

## 0.17.53

## 0.17.52

## 0.17.51

## 0.17.50

## 0.17.49

## 0.17.48

## 0.17.47

## 0.17.46

## 0.17.44

## 0.17.43

## 0.17.42

## 0.17.41

## 0.17.40

## 0.17.39

## 0.17.38

## 0.17.37

## 0.17.36

## 0.17.35

## 0.17.34

## 0.17.33

## 0.17.32

## 0.17.31

## 0.17.30

## 0.17.29

## 0.17.28

## 0.17.27

## 0.17.26

## 0.17.25

## 0.17.24

## 0.17.23

## 0.17.22

## 0.17.21

## 0.17.20

## 0.17.19

## 0.17.18

## 0.17.17

## 0.17.16

## 0.17.15

## 0.17.14

## 0.17.13

## 0.17.12

## 0.17.11

## 0.17.10

## 0.17.9

## 0.17.8

## 0.17.7

## 0.17.6

## 0.17.5

## 0.17.4

## 0.17.3

## 0.17.2

## 0.17.1

## 0.17.0

## 0.16.5

## 0.16.4

## 0.16.3

### Patch Changes

- 721e5b9: - fix(ci): auto-generate changesets in PR workflow
  - fix(core): implement build-time field inheritance for STI classes

## 0.16.2

## 0.16.1

## 0.16.0

## 0.15.5

## 0.15.4

## 0.15.3

## 0.15.2

## 0.15.1

## 0.15.0

## 0.14.7

## 0.14.6

## 0.14.5

## 0.14.4

## 0.14.3

## 0.14.2

### Patch Changes

- dedf98e: - fix(ci): add 30-second delay before enabling auto-merge on version PR

## 0.14.1

## 0.14.0

### Minor Changes

- c45b560: - feat(all): implement multi-level class inheritance support (#247)

## 0.13.7

### Patch Changes

- febac3c: - chore(core): update SDK dependency and remove DuckDB workaround
  - fix(core): implement lazy database table initialization to prevent prerendering crashes
  - fix(ci): resolve issue triage authentication error

## 0.13.6

### Patch Changes

- 5160664: - fix(ci): resolve issue triage authentication error

## 0.13.5

## 0.13.4

### Patch Changes

- 3f46832: - chore(all): update @happyvertical dependencies

## 0.13.3

## 0.13.2

### Patch Changes

- e7fc0d0: - chore(all): update @happyvertical dependencies

## 0.13.1

## 0.13.0

### Minor Changes

- 8b35bce: - feat(all): save aggregated manifest for CLI discovery (#215)

## 0.12.0

### Minor Changes

- 6d80cc4: - test(all): remove flaky default export test (#215)
  - feat(all): integrate dynamic class loader into CLI (#215)
  - feat(all): add dynamic class loader for external packages (#215)
  - feat(all): update consumer plugin to preserve package metadata (#215)
  - feat(all): enhance manifest schema with package metadata (#215)

## 0.11.1

### Patch Changes

- 538c597: - fix(all): use GH_TOKEN for package access in cascade workflow

## 0.11.0

### Minor Changes

- 4bf5d82: - feat(all): add automated dependency cascade workflow

## 0.10.4

## 0.10.3

## 0.10.2

### Patch Changes

- b3be399: - fix(all): exclude protected and private properties from database schema

## 0.10.1

## 0.10.0

### Minor Changes

- c6d8f52: - feat(ci): add auto-update workflow to prevent PR conflicts

## 0.9.0

### Minor Changes

- 85c671b: - feat(ci): add auto-update workflow to prevent PR conflicts

## 0.8.1

## 0.8.0

## 0.7.0

### Minor Changes

- 51c388a: - feat(generators): expose custom methods by default without explicit include
  - fix(cli): load manifest at runtime to populate ObjectRegistry

## 0.5.4

### Patch Changes

- f0d34b0: - docs(all): add comprehensive custom method discovery documentation
- 7c1de77: - feat(core): add getMethods() API to ObjectRegistry for custom method discovery

  - feat(cli): automatically discover and generate CLI commands for custom methods defined on SMRT objects

  Custom methods defined on SMRT objects are now automatically discovered at build time and exposed through the CLI generator. This eliminates the need for manual CLI command configuration for custom methods.

  Example:

  ```typescript
  @smrt({ cli: { include: ["list", "get", "research"] } })
  class Agent extends SmrtObject {
    async research(options: { query: string; depth?: number }) {
      // Custom method automatically gets CLI command:
      // smrt agent:research <id> --query "topic" --depth 5
    }
  }
  ```

## 0.5.3

### Patch Changes

- f9019e6: - fix(scanner): use project tsconfig.json for proper module resolution

## 0.5.2

### Patch Changes

- 694e1da: - fix(manifest): capture package name during registration for external packages

## 0.5.1

### Patch Changes

- 905bdf4: - fix(scanner): use project tsconfig.json for proper module resolution

## 0.5.0

### Minor Changes

- 007567e: - feat(all): add local SDK development setup scripts

## 0.4.2

### Patch Changes

- dfce003: Enable GitHub Package Registry publishing for all SMRT packages

  - Add @happyvertical scope to .npmrc for GitHub Package Registry
  - Configure authentication with GITHUB_TOKEN
  - All packages now publish to https://npm.pkg.github.com/@happyvertical/*
