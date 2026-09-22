# Linux ARM64 VPS

The local VPS deployment supports Linux `arm64` with a systemd user manager. It is entirely headless: installation, updates, inspection, and recovery work over SSH and do not use Electron or desktop APIs. Use Node 22.19 or newer in the Node 22 release line; newer Node release lines remain general bb compatibility targets but are not accepted for Linux ARM64 VPS releases because native provider-worker cleanup is not reliable there. pnpm must exactly match the root `packageManager`. On minimal Debian or Ubuntu images, install `systemd`, `util-linux` for `/usr/bin/flock`, `procps` for `pgrep`, `iproute2` for `ss`, `git`, and `file`; the selected Node installation must include `npm`. The service installer resolves and pins the Node executable used to run it, including user-managed nvm/fnm installations; rerun the installer after replacing that Node installation.

The canonical paths are:

- BB data: `~/.bb`, or the absolute `--data-dir` value
- releases: `~/.local/share/bb-local/releases/<commit>`
- active release: `~/.local/share/bb-local/current`
- updater state: `~/.local/state/bb-local`
- service environment: `~/.config/bb-local/environment`
- maintenance socket: `<BB_DATA_DIR>/admin/maintenance.sock`

Install the user unit, then create and start the first release through the inactive-only bootstrap path:

```sh
pnpm vps:local:service-install -- --data-dir "$HOME/.bb"
pnpm vps:local:update -- --bootstrap
systemctl --user status bb-local.service
journalctl --user -u bb-local.service -n 200 --no-pager
```

The installer reports `sudo loginctl enable-linger <user>` when lingering is disabled. That optional remediation needs administrator access and allows the user service to run without an active login session.

The service binds the server to `127.0.0.1`. Do not publish it directly. Use BB Connect or a private Tailscale Serve endpoint for remote access.

The service uses `ProtectSystem=full` to keep system directories read-only, while intentionally leaving the user's home directory writable. Server-launched host daemons and coding providers can therefore edit normal checkouts such as `~/projects/app`; the commit-addressed runtime releases remain explicitly read-only.

On the Linux VPS, verify the systemd mount policy against a temporary home-directory checkout with:

```sh
BB_VPS_SYSTEMD_INTEGRATION=1 node --test --test-concurrency=1 --test-name-pattern='systemd service policy' scripts/install-local-vps-service.test.mjs
BB_VPS_SYSTEMD_INTEGRATION=1 node --test --test-concurrency=1 --test-name-pattern='build sandbox enters' scripts/update-local-vps.test.mjs
```

## Updates

```sh
pnpm vps:local:update -- --check
pnpm vps:local:update
```

The updater holds `~/.local/state/bb-local/update.lock`, fetches and rebases the clean fork, fetches dependencies without lifecycle scripts, and builds a detached commit-addressed candidate inside a transient systemd sandbox with host networking and user-manager IPC unavailable during executable phases. It marks the release read-only, acquires maintenance, establishes daemon barriers, rechecks all reported activity, seals admission fail-closed, switches `current` atomically, restarts and verifies, then synchronizes Shared Runtime and Directory Skills from the `k0d3r1s/bb-plugins` Git collection before reopening admission. Plugin sources are snapshotted first; a partial synchronization restores every previous source before the server release is rolled back and verified. Pruning precedes the guarded fork push, and push is the last mutation.

Flags:

- `--check`: fetch and report divergence without rebase, build, maintenance, service, plugin, prune, or push mutations.
- `--stage-only`: build and verify a read-only release without maintenance, activation, service, plugin, prune, or push mutations.
- `--skip-plugins`: activate without synchronizing the private plugin collection.
- `--skip-push`: keep the successful local activation without updating the fork remote. Without this flag, the checked-out branch must match `BB_LOCAL_FORK_BRANCH` (default `main`).
- `--allow-active-work`: break-glass acceptance of every reported active thread, terminal, provisioning, agent, workflow, goal, command, hook, provider installation, clone, plugin call/worker, and future descriptor-classified start. The updater enumerates the exact nonzero categories and requires the displayed phrase from an interactive SSH terminal. Without that exact confirmation it releases draining maintenance and exits `5`. New work remains blocked throughout restart.
- `--bootstrap`: activate the first maintenance-capable release only while the old service, BB processes, and listener are inactive.
- `--data-dir <absolute-path>`: select the canonical data directory. If the service installer already recorded another directory, the updater refuses to proceed; rerun `vps:local:service-install` with the new value so the environment and systemd write sandbox stay aligned.
- `--status [operation-id]`: print a durable operation record; omission selects the latest operation.
- `--recover <operation-id>`: use the restrictive owner file to restore and verify a retained operation before releasing maintenance.

Operation JSON and JSONL records are stored in `~/.local/state/bb-local/updates/` with mode `0600`. Exit codes are `0` success, `2` usage, validation, or build failure, `3` unsupported host or bootstrap required, `4` lock/lease contention, `5` active-work refusal, `6` socket or barrier failure, `7` candidate failure with verified rollback, `8` rollback failure with maintenance retained, `9` release, recovery, pruning, or plugin-synchronization failure, and `10` fork-push failure after successful local activation.

## Maintenance CLI

The administrative API exists only on `<BB_DATA_DIR>/admin/maintenance.sock`. The containing directory is mode `0700`; the socket, 256-bit capability, and operation owner files are mode `0600`. It is not mounted on the TCP application. Loopback forwarding headers, Tailscale Serve, and other TCP proxies cannot reach it.

```sh
bb maintenance identity --json
bb maintenance status --json
bb maintenance acquire --reason "operator maintenance" --ttl-ms 300000 --json
bb maintenance renew <operation-id> --ttl-ms 300000 --json
bb maintenance seal <operation-id> --candidate <commit> --previous <commit> --json
bb maintenance transition <operation-id> sealed activating --json
bb maintenance release <operation-id> --resolution completed --json
bb maintenance recover <operation-id> --json
```

Acquire creates `<BB_DATA_DIR>/admin/operations/<operation-id>.json`; an unknown-response retry with `--operation-id` reuses it. The CLI recovery command force-aborts only draining, sealing, or rollback-failed leases. Sealed activation phases require updater-owned rollback through `vps:local:update -- --recover`. Never copy the capability or owner file into proxy configuration, shell history, logs, or chat. Never release or recover an operation owned by a running updater.

Draining TTL defaults to 300000 ms, with a 30000 ms minimum and 1800000 ms maximum. An abandoned draining lease expires open. `sealing`, `sealed`, activation, and rollback are fail-closed and do not expire open. New direct starts receive `work_quiesced` with `retryable: true`; queued work stays queued until release.

The minimum maintenance protocol is `2`; its authenticated identity includes the canonical runtime release path and connected host-daemon IDs used by bootstrap, activation, and normal rollback verification. If the identity probe says the running release predates maintenance, stop the service and use the inactive-only `--bootstrap` path; do not treat an arbitrary socket error as permission to bootstrap. A rollback or interrupted recovery from that bootstrap path can restore a legacy previous release that has no protocol-v2 admin socket. That legacy-only path verifies the exact recorded `current` target, the systemd process working directory, and public health without requiring the unavailable admin identity.

## Recovery

Inspect first:

```sh
operation_id=<operation-id>
state_root="$HOME/.local/state/bb-local"
release_root="$HOME/.local/share/bb-local"
sed -n '1,240p' "$state_root/updates/$operation_id.json"
readlink "$release_root/current"
find "$release_root/releases" -mindepth 1 -maxdepth 1 -type d -print
journalctl --user -u bb-local.service -n 200 --no-pager
bb maintenance status --json
```

| Condition                | Action                                                                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin socket unavailable | Verify `BB_DATA_DIR` in `~/.config/bb-local/environment`, inspect the journal, and restart only after confirming the recorded `current` target.                                                                                       |
| Candidate dead           | Run `pnpm vps:local:update -- --recover "$operation_id"`; it restores the recorded previous target, restarts, verifies the exact target, process release, and public health, then resolves maintenance when protocol v2 is available. |
| Updater interrupted      | Inspect the operation phase and `current`, then rerun `--recover`; do not manually delete the lease or owner file.                                                                                                                    |
| Rollback failed          | Repair the recorded previous release first, atomically restore it, restart and verify, then run owned recovery. Maintenance intentionally remains sealed until verification succeeds.                                                 |

The updater performs the atomic symlink replacement. For manual disaster recovery, create a temporary symlink beside `current` and rename it over `current`; never recursively delete a path named by the operation record. After restart, require the exact recorded target from `readlink`, the systemd process working directory to match it, and a healthy public listener. For a protocol-v2 release, also require successful `bb maintenance identity` and `bb maintenance status` probes before resolving retained maintenance; those probes do not exist when restoring the legacy release recorded by a bootstrap operation.
