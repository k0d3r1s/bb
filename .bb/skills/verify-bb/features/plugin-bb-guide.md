# BB guide plugin

Status: **not live-verified in this change**.

## Setup and entry points

Enable the built-in BB guide plugin, run `bb guide`, and inspect the installed `bb-cli` skill from an agent session.

## Source

- `plugins/bb-guide/package.json`
- `plugins/bb-guide/server.ts`
- `plugins/bb-guide/skills/`

## Feature recipes

| Feature            | Drive                                                                    | Observable success                                                                          |
| ------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| Guide chapters     | Run `bb guide` and each listed chapter.                                  | The overview lists every routed chapter and each renders without an unknown-template error. |
| Agent instructions | Start a session with introduction enabled.                               | The BB CLI introduction appears once with current command guidance.                         |
| Bundled skills     | Toggle the plugin skill settings and start a new session.                | Only enabled bundled skills are exposed to the agent.                                       |
| Maintenance guide  | Run `bb guide maintenance` and inspect the bb-cli maintenance reference. | Unix-socket scope, TTLs, restart barrier, and recovery semantics agree with CLI help.       |

## Evidence and cleanup

Record command output and session-visible skills. Restore the plugin settings changed by the verification run.
