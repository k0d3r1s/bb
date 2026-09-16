# Private fork structure (rebase-friendliness)

> AGENT GENERATED

This fork rides on top of the `_get-bb` upstream (`_get-bb/main`). To keep rebases cheap, fork
additions live in **fork-owned `*.fork.ts` files** and are joined to upstream code at a **single
merge seam**, so upstream literals stay byte-identical and fork work never edits the same growing
lines upstream does.

## Convention

- New fork code (commands, tables, classifications, feature functions) goes in a sibling
  `*.fork.ts` file, never inline in an upstream file.
- The upstream file gets **one stable seam line** — a spread merge, a re-export, or a single
  call-out — not N growing entries.
- Prefer this over editing an upstream literal directly. When you must add to a shared upstream
  registry, add to its `*.fork.ts` companion and let the seam merge it.

## Fork-owned files and their seams

| Fork file | Seam point (upstream file) | What it holds |
| --- | --- | --- |
| `packages/host-daemon-contract/src/quiesce-policy.fork.ts` | re-exported from `src/index.ts`; helper read by `online-rpc.ts` / `command-router.ts` | exhaustive command work-quiesce classification map + `hostDaemonQuiescePolicyForCommand` |
| `packages/host-daemon-contract/src/commands.fork.ts` | `commands.ts`: `hostDaemonCommandRegistry = { ...core, ...fork }` | `work.*` command schemas + registry entries |
| `apps/server/src/services/hosts/wake-policy.fork.ts` | `wake-policy.ts`: `{ ...core, ...fork } satisfies Record<…>` | `work.*` wake entries |
| `packages/db/src/schema.fork.ts` | `schema.ts`: `export * from "./schema.fork.js"` | maintenance tables (`workQuiesce`, `workAdmissions`, …) |
| `packages/db/src/data/index.fork.ts` | `data/index.ts`: `export * from "./index.fork.js"` | work-quiesce / work-admissions data re-exports |

## Exhaustiveness is preserved, not traded away

The classification map and the wake policy each keep an exhaustive
`satisfies Record<HostDaemonRpcCommandType, …>` **on the merged/seam export** (the relocated core
object is loosely typed, since the command-type union now includes the fork's `work.*`). A new
upstream command therefore still fails to compile until it is classified — the difference is that
the fix is a one-line edit in a `*.fork.ts` file, not a merge conflict in an upstream literal.
`commands.fork.test.ts` additionally asserts core/fork command keys never collide.

## What cannot be a seam

Where the fork **modified an upstream function in place** (e.g. `onDaemonSocketOpen` in
`ws/daemon-protocol.ts`, `attachReadyEnvironment` in
`services/threads/thread-environment-directory.ts`, the admission gates in `thread-send.ts` /
`dispatch-attempt.ts` / `terminal-session-lifecycle.ts` / `online-rpc.ts` / `command-router.ts`),
moving it to a fork file does not remove the conflict — it turns a content conflict into a
delete/modify one. These stay in place; the only mitigation is keeping each in-place edit minimal
(a call-out into a fork module) and covering it with ordering/rollback tests before changing it.

## Genuinely-new feature code

New, self-contained fork functions (e.g. the `bb_enter_worktree` / `bb_keep_checkout` worktree
tools) belong in a `*.fork.ts` companion imported by the upstream file — unlike in-place edits,
these are safe to relocate because the bodies move byte-identically.
