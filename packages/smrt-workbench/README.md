# @happyvertical/smrt-workbench

Standard s-m-r-t package workbench.

`pnpm workbench` launches the aggregate workspace host from this repository.
Use `pnpm workbench --package @happyvertical/smrt-content` to focus it on one
workspace package. Consumer projects add `"workbench": "smrt workbench dev"` to
their package scripts after installing `@happyvertical/smrt-cli` and
`@happyvertical/smrt-workbench`.

Yarn consumers must use `nodeLinker: node-modules`. The workbench browser host
is served from the installed package directory and is not available through
Yarn Plug'n'Play's virtual filesystem.

- workspace root: aggregate view of all workspace packages
- package directory: aggregate host focused to that package
- consumer project: installed s-m-r-t package metadata plus local project knowledge

V1 is read-only for command execution. Scripts and validation commands are shown
as copyable commands; the browser UI does not run package tasks.

Package-owned workbench modules can export route modules and metadata:

```ts
import { defineWorkbenchModule } from '@happyvertical/smrt-workbench';

export default defineWorkbenchModule({
  packageName: '@happyvertical/smrt-content',
  routeModules: [CONTENT_ROUTE_MODULE],
});
```
