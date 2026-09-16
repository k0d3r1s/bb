# Browser automation

Status: **not live-verified in this change**.

## Setup and entry points

Enable Browser Automation, read its bundled skill, and use a disposable thread with an available desktop or headless browser runtime.

## Source

- `plugins/browser-automation/package.json`
- `plugins/browser-automation/server.ts`
- `plugins/browser-automation/host.ts`
- `plugins/browser-automation/cli.ts`

## Feature recipes

| Feature              | Drive                                                                 | Observable success                                                       |
| -------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Runtime installation | Inspect status, install the pinned runtime, and inspect status again. | The runtime becomes available at the reported host-local path.           |
| Session lifecycle    | Create, inspect, and close a thread-owned headless session.           | Ownership and generation remain scoped to the requesting thread.         |
| Browser commands     | List tabs and run a harmless script in an acquired session.           | The command returns structured tab and evaluation results.               |
| Failure recovery     | Stop the runtime during a request and retry after restart.            | Failure is bounded and the later session does not reuse stale ownership. |

## Evidence and cleanup

Capture CLI JSON and remove only the disposable sessions and runtime state created by the verification run.
