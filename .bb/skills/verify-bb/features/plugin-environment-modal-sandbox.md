# Modal sandbox environments

Status: **not live-verified in this inventory refresh**.

## Setup and entry points

Enable the optional Modal Sandbox plugin with disposable Modal credentials, a disposable Git project, and a server-access route reachable from Modal.

## Source

- `plugins/environment-modal-sandbox/package.json`
- `plugins/environment-modal-sandbox/server.ts`
- `plugins/environment-modal-sandbox/app.tsx`
- `plugins/environment-modal-sandbox/providers/`
- `plugins/environment-modal-sandbox/README.md`

## Feature recipes

| Feature | Drive | Observable success |
| --- | --- | --- |
| Credentials and account inspection | Configure a disposable Modal token and run account inspection with valid and invalid credentials. | Valid account identity is returned without allocation; rejected credentials remain distinguishable and secret values stay hidden. |
| Image definitions | Show, edit, save, and reset the default image; attempt unsupported Dockerfile instructions. | Valid definitions persist for future machines, reset restores the bundled image, and invalid definitions do not replace the saved version. |
| Debug sandboxes | Build the saved image, run a debug sandbox, execute successful and failing commands, then stop it twice. | Output and exit status are bounded and accurate; ownership checks reject foreign IDs; repeated stop is harmless. |
| Machine creation and checkout | Create a machine-backed environment for the disposable project and run its idempotent setup hook. | Allocation, daemon enrollment, clone, and setup progress converge on one usable checkout without persisting bootstrap credentials. |
| Presets and images | Configure multiple size and image choices, create machines with explicit selections, then reduce each list to one choice. | Selected resources match the requested options; a sole default applies without an unnecessary picker. |
| Suspend and resume | Write a marker, suspend manually and through idle policy, then send a follow-up to resume. | Snapshot state and host identity survive both cycles, queued work waits for active state, and setup remains idempotent. |
| Failure recovery | Cancel during image preparation and allocation, simulate missing compute, and inspect a recoverable lifecycle checkpoint. | Cancellation prevents later allocation, missing compute never restores stale state silently, and retries preserve durable ownership. |
| Removal and retention | Remove a disposable machine after its threads and environments stop, then inspect Modal resources. | Owned compute and private snapshots are gone while shared images, unrelated machines, and user-maintained checkouts remain. |

## Evidence and cleanup

Capture BB lifecycle state and independent Modal resource listings. Remove every disposable machine, snapshot, debug sandbox, credential, and project created by the verification run.
