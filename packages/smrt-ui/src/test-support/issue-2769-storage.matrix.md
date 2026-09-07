# Issue #2769 test design

| Invariant | Evidence |
| --- | --- |
| Browser tests use the original Vitest JSDOM `Storage`, not Node's undefined host accessor | The persistent identity assertion and provider/script persistence, malformed-storage, and throwing-storage cases pass: 20 tests in `/tmp/smrt-2769-theme-tests-final.log`. The base behavior fails all 19 theme cases at `localStorage.clear` (`/tmp/smrt2768-ui-storage-repro.log`). |
| UI browser suite remains compatible | `pnpm --filter @happyvertical/smrt-ui test` passes 847 tests (`/tmp/smrt-2769-ui-test-final.log`). |

Actor: Vitest browser-test worker. Executor: supported Node runtime plus the
JSDOM realm. Transactions, SQL dialects, and external contracts: N/A.
