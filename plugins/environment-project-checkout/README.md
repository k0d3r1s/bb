# Project checkout

Runs threads in the project checkout on an enrolled machine. The plugin supplies the current, existing, and new branch control and refuses branch switches when the checkout is dirty or another live thread occupies it. Removal leaves the checkout intact.

Bundled and installed automatically. Select it through the environment picker or `bb thread spawn --environment-provider project-checkout`. Use `bb environment providers --json` for its inputs and availability.

The Plugin Guide documents the experimental environment-provider contract. Core owns durable launches, retries, cancellation, retirement, and teardown; this plugin owns resource creation and removal.

The internal branch-promotion workflow uses a separate `promotion` input and `promoteBranch` host RPC; public provider validation refuses that reserved input. It requires an existing core reservation, preserves checkout ownership, and reports protocol outcomes through the provider resource. Ordinary branch selection keeps its existing behavior.

On macOS and Linux, promotion validates the source branch and commit, requires a clean checkout with no Git operation in progress, and uses `git switch -c` for a new target or an existing local branch. A fsynced receipt binds the operation ID to its immutable intent before Git can execute. Replays inspect the checkout without repeating the mutation. Recovery creates a durable tombstone for an operation that never started and requires a fresh observation for explicit resolution. The command runs in its own process group, whose ID is recorded before execution. The entire group, including Git hooks, must have terminated before resolution; an alive or inaccessible group keeps the operation uncertain. Successful Git exit also requires observing the requested branch and, for a new branch, its source commit. Other host platforms refuse before mutation.
