# Personal workspace environment provider

Status: **not live-verified in this change**.

## Setup and entry points

Spawn a disposable projectless thread using the Personal workspace environment provider.

## Source

- `plugins/environment-personal-workspace/package.json`
- `plugins/environment-personal-workspace/`

## Feature recipes

| Feature   | Drive                                               | Observable success                                                              |
| --------- | --------------------------------------------------- | ------------------------------------------------------------------------------- |
| Provision | Spawn a projectless personal-workspace thread.      | The environment uses the configured personal workspace on the selected machine. |
| Reuse     | Spawn another thread into the existing environment. | Both threads resolve the same non-provider-owned path.                          |
| Removal   | Delete the environment after its threads stop.      | BB removes its record without deleting the personal directory.                  |

## Evidence and cleanup

Record paths and ownership before cleanup. Preserve all user files in the personal workspace.
