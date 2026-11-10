# Issue 41: sortable generated lists

| Behavior/invariant | Reachable trigger | Positive case | Negative/failure case | Actor/context | Data executor/transaction | Runtime/dialect | External contract edge | Test level | Validation command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Clicking a data header sorts ascending, then descending | Click or keyboard activate a header button | Text, number, date, boolean, and relation labels sort by displayed meaning; ties retain source order | Missing values stay last in either direction; source rows do not mutate | Planner visitor in model, product, or child list | Local derived view only; no write | Browser/Svelte | N/A: no external request | Unit plus native UI | `pnpm vitest run tests/list-sort.test.ts`; native app tab |
| Sorting remains usable and announced | Move keyboard focus to a column header | Button is focusable; selected `th` has `aria-sort`; direction is visible | Actions column cannot sort | Keyboard and assistive technology user | N/A: display only | Browser/Svelte | N/A: local UI | Native UI inspection | Native app tab |
| Generated lists keep useful table hierarchy | View seeded records with varied columns | Rows remain aligned and readable, with horizontal overflow on narrow view | No card wrap or clipped columns | Planner visitor | N/A: display only | Browser/Svelte | N/A: local UI | Native UI inspection | Native app tab |

UI-only visual checks and focused tests run during the QA batch. Repository-wide gates and review remain deferred until the batch closes.
