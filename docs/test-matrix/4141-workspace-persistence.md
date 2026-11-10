# #4141 workspace persistence and reset

Risk: standard browser persistence; no SQL executors or transactions (N/A).
Designed before implementation; raw Storage strings migrate without reserialization.

| Behavior / reachable trigger | Positive / negative case | Actor/context | Executor/runtime | External edge | Level / command |
| --- | --- | --- | --- | --- | --- |
| default editing/reload | plan, manual rows, context, native thread and seed retained / new no-opener tab empty | anonymous same/new tab | session Storage, browser; fake Storage node test | unavailable storage | unit: `pnpm exec vitest run tests/workspace-storage.test.ts` from planner |
| Remember toggle | exact bytes moved both ways, old live copies removed / quota refusal keeps source and rolls destination back | same origin visitor | local + session Storage | quota exception | same unit command |
| legacy initial visit | immutable exact raw archive + session copy, live legacy retired after copy / malformed raw retained, failure preserves originals | existing visitor | local + session Storage | malformed source and quota | same unit command |
| recover/discard/OFF | restore raw archive; OFF deletes durable archive / malformed archive refused | existing visitor | current target + local archive | untrusted raw JSON | same unit command |
| confirmed reset | plan/rows/context/thread/seed/host-draft/archive removed; undo cleared / theme, identity and unrelated keys remain | current workspace visitor | exact owned keys only | no broad clear | unit + DOM integration by UI/lead owners |
| async reset | native cancels before state mutation; late inference cannot apply / irreversible lead in-flight disables reset | current visitor | native transport generation | provider ignoring abort | native transport tests by lead owner |
| manual sample context | first install retained across followups / invalid sample rejected atomically | current visitor | workspace facade | malformed structured context | `pnpm exec vitest run tests/sample-context.test.ts` |

Legacy migration is visible through recoveryAvailable. Backup survives ordinary
session edits and explicit Remember ON; discard, explicit Remember OFF, and
confirmed reset delete it. Shell/theme preferences and inference credentials
remain outside workspace ownership.

Atomic reset failure regression: snapshot owned storage + metadata before removal, rollback exact raw values after a failed removal, then return false before touching plan/native/sample state. Coordinator failure and callback-finally cases: `pnpm exec vitest run tests/workspace-reset.test.ts tests/workspace-storage.test.ts`. Node 26.8.1 final focused 4-file run passed 48 tests.

Latest user steering: raw native conversation, seed markers, contact and frozen lead draft are ALWAYS session-only even with Remember ON. Remember migrates only cookbook/library/sample context/rows. New-tab Remember restores project values with fresh chat/draft. Legacy durable ephemeral copies move exact bytes into session before removal; conflicting old frozen lead identifiers stay in session-only `smrt-planner:ephemeral-recovery:v1`. Durable legacy archives are stripped of those ephemeral keys. Focused regression: toggle both ways, fresh tab, legacy archive cleanup/conflicting id, quota refusal.
