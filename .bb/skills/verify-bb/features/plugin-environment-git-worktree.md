# Git worktree environment provider

Status: **not live-verified in this change**.

## Setup and entry points

Use a disposable Git project and select the Worktree environment provider when spawning a thread.

## Source

- `plugins/environment-git-worktree/package.json`
- `plugins/environment-git-worktree/`

## Feature recipes

| Feature         | Drive                                                                       | Observable success                                                            |
| --------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Provision       | Spawn into a new managed worktree.                                          | The environment owns a worktree on the selected base branch.                  |
| Lifecycle hooks | Configure setup and teardown hooks, then create and remove the environment. | Hook results and failures follow the core lifecycle contract.                 |
| Cleanup         | Archive the last thread or request environment deletion.                    | Retirement removes only the provider-owned worktree after running work stops. |

## Evidence and cleanup

Record environment status and Git worktree state. Remove only the disposable provider-owned worktree.
