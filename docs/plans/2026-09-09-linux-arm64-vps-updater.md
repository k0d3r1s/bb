# Linux ARM64 VPS Updater Implementation Plan

## Goal

Add a headless, CLI-driven update path for a Linux `arm64` VPS that can build a commit-addressed read-only `bb-app` release, quiesce all new work without an admission race, activate it through a systemd user service, roll back on failure, update the local plugins, and push the rebased fork only after the whole operation succeeds.

The updater must not depend on Electron, a desktop session, or any GUI API. The server remains bound to loopback; remote access is provided separately through BB Connect or Tailscale Serve.

## Decisions and provenance

- The existing macOS updater in `scripts/update-local-desktop.mjs` remains the behavioral source for remote discovery, clean-worktree enforcement, rebase rules, plugin replacement, and guarded fork pushes.
- Linux VPS activation uses detached commit-addressed worktrees made read-only under `~/.local/share/bb-local/releases/<commit>` and an atomically replaced `~/.local/share/bb-local/current` symlink. The primary checkout is never the running release.
- The systemd user service runs `bb-app` from `current`; the updater itself is a repository-local command, not a feature of the process being replaced.
- Update builds finish before work is quiesced. The quiesce interval covers only the final activity check, activation, health and plugin checks, rollback if needed, and restoration of admissions.
- Restart safety is enforced by a persisted server-owned work-quiesce lease and an ordered host-daemon barrier. A point-in-time active-thread check alone is explicitly insufficient.
- Every host command descriptor carries mandatory, compiler-enforced quiesce policy metadata. Both settled-command and online-RPC transports enforce it; a hand-maintained partial list is not acceptable.
- Draining leases expire to recover from a lost acquirer, but activation enters an ordered persisted `sealing` phase before any daemon is told to seal. Restart remains forbidden until every cohort daemon acknowledges and SQLite advances to `sealed`. Sealing and sealed phases never reopen admission merely because wall-clock time passes; they require verified success, verified rollback, or an authenticated local recovery action.
- Maintenance operations are served only on a filesystem-protected Unix administrative socket and require a local administrative capability read from the data directory. They are not registered on the TCP HTTP listener that BB Connect, Tailscale Serve, or another reverse proxy can reach.
- `--stage-only` builds a candidate without changing `current`, plugins, maintenance, systemd, pruning, or remotes. The ambiguous `--skip-restart` flag is not introduced.
- `--allow-active-work` is an explicit break-glass override for every reported active category, not only threads. It never bypasses the quiesce lease, daemon barrier, or rejection of new work.

## Safety invariant

Every authoritative operation that admits executable work must read the global work-quiesce lease inside the same SQLite `immediate` transaction that records or claims that work.

That gives a concurrent work admission and quiesce acquisition only two valid outcomes:

1. The quiesce transaction commits first. The admission observes the lease, returns a stable retryable maintenance result, and sends no start command to a daemon.
2. The work transaction commits first. Quiesce acquisition succeeds afterward, and the mandatory post-barrier activity snapshot observes the committed work, so default activation aborts before `systemctl restart`.

The updater holds the lease through candidate activation and every rollback check. A release does not reopen server admission first: it removes daemon gates while the database lease is still present, then conditionally deletes the matching lease, and only then wakes queued dispatchers.

## Target update sequence

```text
validate host, checkout, remotes, and clean worktree
fetch and rebase against upstream
create/build/test commit-addressed candidate release
atomically acquire persisted work-quiesce lease
establish an ordered quiesce barrier on every connected daemon
re-check server and daemon activity after all barrier acknowledgements
abort safely if activity exists, unless break-glass was explicit
seal the lease into durable fail-closed activation state
atomically switch current symlink to the candidate
restart the systemd user service
verify server identity, health, daemon reconnection, and plugins
on failure, restore the previous symlink and restart/verify the previous release
unquiesce daemons while the database lease is still held
release the matching database lease and wake queued work
prune old unreferenced release worktrees
push the fork with the existing force-with-lease protection as the final mutation
```

The updater is an explicit persisted state machine. Before sealing, failure cleanup performs the same ordered release and the bounded draining lease can expire. After sealing, automatic cleanup releases only after candidate success or a verified rollback; rollback failure retains the fail-closed lease for local recovery. A per-operation owner secret stored with mode `0600` makes acquisition retryable after a lost response and lets the same SSH operator resume recovery without exposing another owner's lease.

## Task 1: Persist the global work-quiesce lease

**Files**

- Modify `packages/db/src/schema.ts`.
- Add `packages/db/src/data/work-quiesce.ts`.
- Add `packages/db/src/data/work-admissions.ts`.
- Modify `packages/db/src/data/index.ts`.
- Add `packages/db/test/work-quiesce.test.ts`.
- Add `packages/db/test/work-admissions.test.ts`.
- Generate a migration under `packages/db/drizzle/` with the package generator.

**Implementation**

1. Add a singleton `work_quiesce` table whose only valid scope is `global`, with `operation_id`, `owner_secret_hash`, `reason`, `phase`, `acquired_at`, `expires_at`, cohort metadata, candidate/previous release identities, and phase timestamps. Model `phase` as `draining | sealing | sealed | activating | verifying | rolling-back | rollback-failed | releasing`; impossible phase/expiry combinations must be rejected by the data API.
2. Add `work_admissions` for execution-start operations that lack an existing authoritative domain record. Store admission ID, descriptor type, transport, host, operation context, state, and timestamps. Add durable release/recovery audit rows so reconnecting daemons can clear a gate for a resolved operation before becoming dispatchable.
3. Implement `acquireWorkQuiesceLease`, `readWorkQuiesceLease`, `renewDrainingWorkQuiesceLease`, `beginWorkQuiesceSeal`, `completeWorkQuiesceSeal`, `transitionWorkQuiescePhase`, and `releaseWorkQuiesceLease`. Every ownership mutation verifies the operation ID plus owner secret hash. Acquisition, sealing transitions, and release use `db.transaction(..., { behavior: "immediate" })`.
4. Treat an expired `draining` row as open admission and allow acquisition to atomically replace it. Once `sealing` begins, expiry never opens admission or daemon gates: only matching-owner verified completion, verified rollback, or an explicit capability-authenticated local recovery command can resolve it.
5. Make acquire idempotent for the same client-generated operation ID and owner secret. A retry after an unknown HTTP outcome returns the same lease state; a different owner receives stable contention without learning the secret.
6. Add `admitExecutionStart(tx, descriptor, context, now)` and return a branded `WorkAdmissionToken` that execution-start transports require. In the same immediate transaction it checks quiesce and either associates an existing authoritative domain start or inserts a ledger row. Mark the admission settled only after dispatch fails or tracked execution completes.
7. Add `assertWorkAdmissionOpen(tx, now)` for existing domain admission transactions. Return a typed retryable maintenance result rather than relying on string matching.
8. Make lease acquisition block admission immediately, before any daemon barrier is attempted. Barrier progress is operational metadata; it must never create a state in which the lease exists but admissions remain open.
9. Generate the migration with `pnpm --filter @bb/db db:generate`. Do not edit Drizzle snapshot JSON manually.
10. Use `createConnection(":memory:")` plus `migrate(db)` for single-connection data behavior. Use a temporary file-backed SQLite database and two real connections for persistence, acquisition contention, and deterministic transaction interleavings.

**Done when**

- Exactly one unexpired global lease can exist.
- A lease survives closing and recreating the server connection against the same database.
- Expired draining leases no longer block admission, sealing/sealed leases remain fail-closed, and stale owners cannot mutate the current lease.

## Task 2: Put the lease check inside every authoritative work admission

**Files**

- Modify `apps/server/src/services/threads/dispatch-attempt.ts`.
- Modify `apps/server/src/services/threads/thread-send.ts`.
- Modify `apps/server/src/services/threads/queued-messages.ts`.
- Modify `apps/server/src/services/threads/queued-message-dispatch.ts`.
- Modify `apps/server/src/services/threads/queue-waits.ts`.
- Modify `apps/server/src/services/threads/thread-lifecycle.ts`.
- Modify `apps/server/src/services/terminals/terminal-session-lifecycle.ts`.
- Modify `apps/server/src/routes/terminals.ts`.
- Modify `apps/server/src/services/hosts/live-command.ts`.
- Modify `apps/server/src/services/hosts/online-rpc.ts`.
- Modify `apps/server/src/services/plugins/plugin-host-rpc.ts`.
- Modify `packages/domain/src/queued-message.ts`.
- Modify `packages/host-daemon-contract/src/commands.ts`.
- Add focused tests beside the affected server service tests.

**Implementation**

1. Add mandatory `quiescePolicy` metadata to every host command descriptor, using an exhaustive discriminated value such as `allowed | execution-start`. The descriptor registry must fail TypeScript compilation when any settled-command or online-RPC descriptor omits the policy. Classify initial thread/turn commands, queue claims, agents, workflows/goals, interaction continuation, provisioning, terminals, `project.clone`, `environment.hook.run`, `provider.installation.run`, and `plugin.host.call`, plus every other current descriptor.
2. In each transaction that records or claims the authoritative start, call `assertWorkAdmissionOpen` before changing state. Convert deferred transactions to `behavior: "immediate"` where needed so they serialize with lease acquisition. Reuse the `runImmediateQueueMutation` pattern from `packages/db/src/data/queued-thread-messages.ts` rather than adding an uncoordinated preflight check.
3. For online RPCs and other execution starts without a domain transaction, create a `work_admissions` row inside an immediate transaction and require its branded token at the send/worker-creation call. A request paused after ledger commit but before daemon send is visible to the post-acquire snapshot; a request paused before commit loses to the quiesce lease. A standalone preflight read is forbidden.
4. Add `maintenance` to the queued-message wait reason union. Existing queued items stay queued while quiesced; dispatch loops register the wait instead of consuming or failing them.
5. For direct user submissions that cannot remain queued, return one typed error code, `work_quiesced`, with `retryable: true`, lease reason, and expiry. Do not expose the owner secret.
6. Enforce descriptor policy and require a valid admission token in both `live-command.ts` and `online-rpc.ts`: no command marked `execution-start` can be sent while the lease is active. Include plugin-host worker creation, pending ledger rows, and outstanding online RPCs in gate/activity accounting. This is defense in depth; it does not replace transactional admission.
7. Leave stop, interrupt, cancellation, status, read, and recovery operations available so active work can drain and operators can inspect the system.
8. Add a table-driven contract test that enumerates every command descriptor, asserts it has a policy, and sends every `execution-start` command through its actual transport while quiesced. Each case must return the stable maintenance result and record zero daemon dispatch/worker creation.

**Done when**

- No accepted work can cross from server state into a new daemon execution after quiesce commits.
- Queued work remains durable and resumes after release.
- Read and stop operations continue to work during maintenance.
- Adding a new host command without an explicit quiesce policy is a compile/test failure.

## Task 3: Add an ordered host-daemon quiesce barrier

**Files**

- Modify `packages/host-daemon-contract/src/protocol.ts`.
- Modify `packages/host-daemon-contract/src/commands.ts` and its result schemas.
- Modify `packages/host-daemon-contract/test/contract.test.ts`.
- Modify `apps/server/src/services/hosts/live-command.ts`.
- Modify `apps/server/src/services/hosts/online-rpc.ts`.
- Add `apps/server/src/services/hosts/work-quiesce.ts`.
- Modify `apps/server/src/ws/daemon-protocol.ts`.
- Modify `apps/server/src/ws/hub.ts`.
- Modify `apps/host-daemon/src/command-router.ts`.
- Modify `apps/host-daemon/src/command-dispatch.ts`.
- Modify `apps/host-daemon/src/runtime-manager.ts`.
- Modify `apps/host-daemon/src/plugin-host-manager.ts`.
- Modify `apps/host-daemon/src/app.test.ts`.
- Modify `apps/host-daemon/test/command/command-router.test.ts`.
- Add `apps/host-daemon/test/command/work-quiesce-races.test.ts`.

**Implementation**

1. Increment `HOST_DAEMON_PROTOCOL_VERSION` from `195` because the command wire contract changes.
2. Add idempotent lease-scoped daemon commands for `work.quiesce`, `work.seal`, and `work.unquiesce`. Quiesce carries the operation ID and draining expiry. Seal converts the matching daemon gate to fail-closed activation mode. Unquiesce succeeds only for the matching operation after verified success/recovery; only an unsealed draining gate self-releases at expiry.
3. Route quiesce and seal through the same ordered per-session command transport as every command whose descriptor policy is `execution-start`, including online RPC. On WebSocket ordering, all start frames sent before the barrier arrive before it; starts received after the barrier are rejected until release.
4. The daemon installs its gate before acknowledging. The ACK waits until every earlier received settled or online-RPC start admission has either entered runtime/plugin-worker tracking or failed, then returns an activity snapshot covering active runtimes, background agents, workflows, commands, terminals, plugin calls/workers, provider installation, hooks, clones, and other descriptor-classified executable work.
5. Make `CommandRouter.executeLiveDaemonCommand`, `CommandRouter.executeOnlineRpcCommand`, command dispatch, runtime starts, and `PluginHostManager.ensureWorkerNow` enforce the descriptor policy against the in-memory gate. Stop, interrupt, cancellation, status, and activity snapshot commands remain allowed.
6. Serialize barrier cohort capture with the real registration seams `onDaemonSocketOpen` and `Hub.registerDaemon`. A daemon connecting while the database lease exists stays unavailable for dispatch, installs the daemon gate, reports activity, and only then becomes a quiesced session. Suppress the current post-registration queue wake until that handshake completes. Acquisition cannot return `barrierEstablished` while a registration that began in its cohort is unresolved. A daemon that cannot acknowledge is a failed barrier, not an implicitly idle daemon.
7. Build the server activity snapshot from persisted admitted states, not only currently connected runtime projections. It includes starting and active turns, claimed queue messages, background agents, workflows, goals, provisioning starts, terminal starts/sessions, and outstanding execution-start host commands. A disconnected or concurrently reconnecting host therefore cannot hide already-admitted work.
8. Seal in a fail-closed ordered protocol, never a distributed atomic claim: first persist `sealing` and the exact cohort in an immediate SQLite transaction; then send idempotent `work.seal` to every cohort member; then persist each ACK; only after all ACKs commit may SQLite advance to `sealed` and the updater call `systemctl`. A database-first failure or partial daemon failure remains blocked in `sealing`, reports unresolved members, and permits only resume-seal or authenticated abort/recovery. A daemon-seal-before-database state is impossible by construction.
9. During `sealing`, a connecting/reconnecting daemon reports its gate state and cannot become dispatchable. If it belongs to the persisted cohort, resume its required seal; if it is new, install a sealed gate before registration completes. Restart remains forbidden until the cohort and registration barrier are stable and every required ACK is durable.
10. On server startup, admission remains database-gated automatically and daemon sessions are not dispatchable until the persisted draining, sealing, or sealed lease has been re-applied. Startup must not briefly reopen work because in-memory barrier state is empty.
11. Update the pinned protocol-version assertion from `195` and add schema/round-trip tests for quiesce, seal, unquiesce, policies, activity results, mismatched owners, and phase transitions.
12. Release is also ordered: persist `releasing` while SQLite still blocks admission; unquiesce every reachable cohort member and persist each ACK; refuse lease deletion while any reachable sealed member is unresolved; then durably record recovery/release and delete the gate in one transaction. A disconnected daemon reports its stale operation on reconnect and must consume the durable release record/clear command before becoming dispatchable.

**Done when**

- A barrier ACK cannot race ahead of an earlier start admission.
- A daemon joining during maintenance is never briefly dispatchable.
- Draining expiry recovers abandoned acquisition, while a sealed activation never silently fails open.
- Partial sealing forbids restart and is idempotently resumable or recoverable without orphaning a fail-open participant.

## Task 4: Expose maintenance and activity through server, SDK, and CLI

**Files**

- Modify `packages/server-contract/src/api/system.ts`.
- Add `packages/config/src/admin-socket.ts`.
- Modify `packages/config/package.json`.
- Modify `apps/server/src/start-server.ts`.
- Add `apps/server/src/admin-server.ts`.
- Add `apps/server/src/routes/admin-maintenance.ts`.
- Add `apps/server/src/services/system/work-quiesce.ts`.
- Modify `packages/sdk/src/areas/system.ts`.
- Add `packages/sdk/src/node-admin.ts`.
- Modify `packages/sdk/src/node.ts`.
- Modify `packages/sdk/package.json`.
- Add `packages/sdk/test/node-admin.test.ts`.
- Add `apps/cli/src/commands/maintenance.ts`.
- Modify `apps/cli/src/command-groups.ts`.
- Add `apps/cli/src/__tests__/command-output/maintenance.test.ts`.
- Modify `.bb/skills/verify-bb/scripts/inventory.py`.

**Contract**

- `GET /maintenance` returns phase, non-secret operation ID, reason, draining expiry, barrier status per connected host, and the combined server/daemon activity snapshot.
- `POST /maintenance/acquisitions` receives a client-generated operation ID, owner secret, reason, and `ttlMs`. It returns `201` for a new acquisition and `200` with the same state for an idempotent same-owner replay after response loss.
- `POST /maintenance/renew` renews the matching unsealed acquisition.
- `POST /maintenance/seal` atomically verifies the owner, unexpired draining lease, settled barrier, and activity policy while persisting `sealing`; it then runs the ordered daemon seal protocol and returns success only after every ACK is durable and SQLite reaches `sealed`.
- `POST /maintenance/phase` records a valid matching-owner activation/verification/rollback transition.
- `POST /maintenance/release` performs ordered daemon release, conditionally deletes the database lease after verified success or rollback, and wakes queue dispatch.
- `POST /maintenance/recover` accepts a discriminated action: `{ action: "resume-seal", operationId, ownerSecret }`, `{ action: "release-verified", operationId, ownerSecret, expectedReleaseIdentity }`, or `{ action: "force-abort", operationId, expectedReleaseIdentity, confirmation }`. Resume-seal continues missing ACKs. Release-verified validates candidate/previous build identity and the persisted updater phase before ordered release. Force-abort requires the admin capability, exact operation/current-target confirmation, server-side identity checks, and writes an audit result; it cannot silently assert rollback.
- Owner secrets are carried only in authenticated Unix-socket request bodies or dedicated headers and stored only as hashes in SQLite. They never appear in URL paths, normal logs, status output, or errors.
- Acquisition does not claim safety until every connected daemon has acknowledged and the post-barrier activity snapshot has been collected.

Successful responses use `200`, `201`, and `204` as described. Errors use one shared `{ requestId, code, message, retryable, retryAfterMs?, details? }` schema: `401` for missing admin capability, `403` for a wrong capability, `409` for lease contention/stale owner/invalid phase/unsafe active work, `422` for request or TTL validation, `503` plus `Retry-After` for barrier or temporarily unavailable daemon failure, and `504` for a bounded operation deadline. Every response carries the request ID header.

**CLI**

- `bb maintenance identity [--data-dir <absolute-path>] [--json]`
- `bb maintenance status [--data-dir <absolute-path>] [--json]`
- `bb maintenance acquire --reason <text> [--ttl-ms <milliseconds>] [--data-dir <absolute-path>] [--json]`
- `bb maintenance renew <operation-id> [--ttl-ms <milliseconds>] [--data-dir <absolute-path>] [--json]`
- `bb maintenance release <operation-id> [--data-dir <absolute-path>] [--json]`
- `bb maintenance recover <operation-id> [--data-dir <absolute-path>] [--json]`

**Implementation**

1. Parse and validate request and response data in the server contract. The SDK returns typed values without rebuilding policy.
2. Derive the socket at `<BB_DATA_DIR>/admin/maintenance.sock` and a 256-bit random capability at `<BB_DATA_DIR>/admin/capability`; do not add remotely supplied overrides. Validate with `lstat`/no-follow operations that the admin directory and capability are owned by the service user, have modes `0700`/`0600`, and are directories/regular files rather than links or special files. Create secrets with exclusive open, never print/log/return them, and reject unsafe existing filesystem state.
3. Serialize listener ownership with an atomic updater-independent lock under the admin directory. On collision, perform a capability-authenticated identity probe and refuse to unlink a live server socket. Reclaim stale ownership with an atomic rename-and-create protocol. Record the bound socket's device/inode plus a random server-instance nonce, and unlink on shutdown only if both the lock nonce and current device/inode still match. Test two-server startup and live/stale collisions.
4. Start a minimal administrative router on the Unix socket. Register only health/identity needed by the local client and the maintenance contract. Require the capability on every request and compare it without timing-sensitive string equality. Do not mount the normal application router on this listener, and do not register maintenance routes on `BB_SERVER_BIND_HOST:BB_SERVER_PORT` at all.
5. Add a Node-only SDK administrative transport backed by `node:http` `socketPath`. It reads the capability locally and places it only on the Unix-socket request. The browser SDK and normal `baseUrl` transport do not gain maintenance mutation methods. Have the CLI derive the same socket and capability paths from local BB data-dir configuration and call the typed Node administrative client.
6. Before acquire, generate the operation ID and owner secret and durably write `<BB_DATA_DIR>/admin/operations/<operation-id>.json` with mode `0600`. Retrying reads this owner file and receives the same server lease. `status` exposes the non-secret operation ID; renew/release/recover require the matching owner file. Capability-authenticated forced recovery without the owner file must require an explicit confirmation and cannot release until the operator verifies or performs rollback.
7. Enforce `ttlMs` at the server boundary: default five minutes, minimum 30 seconds, maximum 30 minutes, safe-integer arithmetic only. Reject overflow or a value too short for the current barrier deadline. Surface the bounds in CLI help and structured `422` details.
8. Make acquire all-or-nothing from the caller's perspective: if any barrier fails, retain the database lease during cleanup, unquiesce acknowledged daemons, release the matching lease, then return the failure. Same-owner retries expose cleanup state rather than claiming contention.
9. Keep the acquire response distinct between `barrierEstablished` and `safeToRestart`. The latter is true only when the post-barrier activity snapshot is empty. Seal first revalidates the matching current lease and safety decision in SQLite, enters `sealing`, executes the ordered daemon protocol, and returns success only from durable `sealed` state.
10. Once the ordered barrier has settled, activity is monotonic toward idle: transactional server admission is closed and daemon gates reject execution starts, so no new active state can appear between the empty snapshot and seal. Test this invariant directly.
11. Publish CLI exit codes in help and docs: `0` success, `2` usage/validation, `3` unsupported host/bootstrap required, `4` lease contention or stale owner, `5` active-work refusal, `6` socket/barrier transport failure, `7` candidate failure with verified rollback, `8` rollback failure with maintenance retained, `9` release/recovery failure, and `10` fork-push failure after local activation succeeded.
12. Test every recovery action and invalid phase/identity/owner combination. Partial seal recovery returns per-host state; release refuses an unverified rollback and refuses deletion while a reachable sealed cohort member lacks an unquiesce ACK.
13. Add a negative integration test that sends every maintenance method to the TCP listener with loopback and proxy forwarding headers and receives `404`. Over the Unix socket, assert missing and wrong capabilities are rejected, the correct local capability succeeds, and the directory/socket/capability modes are restrictive. This proves a Tailscale Serve connection forwarded to loopback cannot acquire or release maintenance.

**Done when**

- A headless operator can acquire, inspect, renew, and release maintenance entirely through `bb`.
- The updater can determine restart safety from one typed acquire response without reading GUI state.
- Remote and loopback-proxied HTTP clients cannot reach the maintenance surface or obtain its capability; an SSH user running the local CLI can.

## Task 5: Build the Linux ARM64 updater and systemd installer

**Files**

- Add `scripts/update-local-vps.mjs`.
- Add `scripts/update-local-vps.test.mjs`.
- Add `scripts/install-local-vps-service.mjs`.
- Add `scripts/install-local-vps-service.test.mjs`.
- Add `scripts/local-vps-operation.mjs`.
- Add `scripts/local-updater-common.mjs` if extraction is needed.
- Modify `package.json`.
- Reuse or extract narrowly shared pure helpers from `scripts/update-local-desktop.mjs`; keep platform-specific activation separate.

**Commands**

- `pnpm vps:local:service-install`
- `pnpm vps:local:update`
- Updater flags: `--check`, `--stage-only`, `--skip-plugins`, `--skip-push`, `--allow-active-work`, `--bootstrap`, `--data-dir <absolute-path>`, `--status [operation-id]`, and `--recover <operation-id>`.

**Implementation**

1. Refuse any platform except `linux` plus `arm64`. Verify Node and pnpm versions from the repository engines, `/usr/bin/flock`, a functioning systemd user manager, sufficient writable storage, a clean primary worktree, and unambiguous upstream/fork remotes before mutation.
2. Resolve one absolute BB data directory and persist it in `%h/.config/bb-local/environment` with mode `0600`; the systemd unit and interactive updater read this file. An explicit updater `--data-dir` must match the installed value or fail with instructions to rerun the installer, because the unit's write sandbox also embeds that directory. Diagnostics print the resolved data directory and socket path but never the capability or owner secret.
3. Acquire an exclusive nonblocking `flock` on `%h/.local/state/bb-local/update.lock` before fetch/rebase and hold it through activation, recovery, pruning, and push. A concurrent updater exits with the running operation ID and status command.
4. Generate an operation ID immediately and durably record every state transition and result in `%h/.local/state/bb-local/updates/<operation-id>.json` plus a JSONL log, both mode `0600`. Model `validating -> building -> draining -> sealing -> sealed -> activating -> verifying -> rolling-back -> rollback-verified -> releasing -> pruning -> pushing -> complete`, with terminal failure phases. `--status` reads these records after SSH disconnects.
5. Reuse the desktop updater's URL-based remote classification, explicit environment overrides, rebase rule, and `--force-with-lease=<branch>:<previous-head>` push construction. Reject overrides that resolve upstream and fork to the same remote. Treat the configured upstream/fork URLs and their fetched reachable commits as the explicit source-trust boundary and record both resolved commit IDs; do not imply the lockfile authenticates source.
6. Fetch both remotes, report upstream distance and local patch count, and make `--check` exit before rebase, install, quiesce, service changes, plugin changes, pruning, or push.
7. Rebase the clean patch branch on the configured upstream branch, then create a detached release worktree at `%h/.local/share/bb-local/releases/<commit>`. Reuse an existing complete release for the same commit; reject or recreate only updater-owned incomplete release directories.
8. Execute all candidate-controlled package-manager lifecycle scripts, generators, builds, tests, and smoke commands inside a transient systemd user sandbox. Hide the production BB data/admin directories with `ProtectHome`/bind-path rules, expose only the candidate and dedicated build cache as writable, use `ProtectSystem=strict`, `PrivateTmp`, `NoNewPrivileges`, `RestrictSUIDSGID`, and `UMask=0077`, and scrub BB/admin credentials from the environment. A sandbox preflight must prove the candidate cannot read the production database or capability before executing candidate code.
9. Build inside that sandbox with frozen dependency resolution:
   - `pnpm install --frozen-lockfile`
   - `node --test scripts/update-local-vps.test.mjs`
   - `node --test local/plugins/shared-runtime/test/`
   - `npm ci --ignore-scripts --prefix local/plugins/dir-skills`
   - `npm run typecheck --prefix local/plugins/dir-skills`
   - `pnpm exec turbo run build --filter=bb-app`
   - `pnpm --filter bb-app smoke:tarball`
10. Verify the packed executable and native dependencies report Linux `aarch64`/ARM64 and perform the tarball smoke on the VPS. Do not cross-build or accept an x64 artifact. Mark the completed commit-addressed release tree read-only before it can become `current`.
11. Install a systemd user unit whose `ExecStart` uses `%h/.local/share/bb-local/current` or a generated absolute path, never shell `~` expansion. Load the canonical environment file, restart on failure, bind the server to loopback, make release paths read-only, and allow writes only to the explicit BB data/state paths. Run `systemctl --user daemon-reload` and enable the unit. Detect disabled user lingering and print the exact `sudo loginctl enable-linger <user>` remediation, explaining that it needs administrator access.
12. `--stage-only` stops after the verified read-only candidate is built. It does not acquire maintenance, change `current`, install plugins, modify systemd, prune, or push. Remove `--skip-restart` rather than leaving a next-boot mutation with unclear guarantees.
13. Probe the admin socket identity/protocol before activation. If a running pre-maintenance release lacks it, refuse automatic update with exit `3` and exact bootstrap instructions. `--bootstrap` is permitted only when the service is inactive and no BB server/daemon process or listener is present; it installs and starts the first maintenance-capable release without pretending to drain an old server.
14. Build before acquiring maintenance. Use the already-persisted operation ID/owner secret for idempotent Unix-socket acquire. Refuse sealing unless the ordered barrier is established and the post-barrier activity snapshot is empty. `--allow-active-work` may waive only that empty-snapshot refusal and must enumerate and require confirmation of every active category being overridden.
15. Give every external operation an enforced deadline: daemon barrier, systemd stop/restart, admin-socket return, identity/health, plugin verification, rollback restart, and cleanup. Before restart, call seal; it first atomically revalidates the current owner, unexpired draining phase, barrier, and activity policy and persists `sealing`, then waits for every ordered daemon seal ACK and the final `sealed` commit. If draining expiry occurs before `sealing`, or any cohort ACK is missing afterward, seal does not succeed and `systemctl` is never called.
16. Save the previous symlink target, atomically replace `current` with a temporary symlink plus rename, then run the bounded `systemctl --user restart bb-local.service`.
17. Verify the restarted service reports the candidate commit/build identity, healthy admin and public listeners, and expected daemon reconnection. Run plugin install/migration/replacement checks from the commit-addressed candidate release so path plugins do not point at the mutable primary checkout.
18. If activation, health, daemon, or plugin verification fails, keep the sealed gate, atomically restore the previous symlink, restart the service within its deadline, and verify the previous release identity and health. Report both failures. A generic `finally` may release only before seal, after candidate success, or after `rollback-verified`; `rollback-failed` remains sealed for `--recover` or explicit local forced recovery.
19. On verified candidate success or rollback, transition to releasing, unquiesce daemons, release the database gate, verify admission is open, and delete the operation owner file only after the final state record is durable.
20. Prune only updater-owned detached worktrees that are neither `current` nor the rollback target. Preserve a bounded set of successful releases and never recursively delete an unresolved path. A pruning failure aborts before remote mutation.
21. Push the fork last. Never push if activation, plugin checks, rollback checks, maintenance release, or pruning failed. If the guarded push itself fails, retain the successful local release and return exit `10` with an exact retry command.

**Done when**

- The complete update runs over SSH with no GUI or desktop dependencies.
- The running release is commit-addressed and read-only and can be rolled back by an atomic symlink swap.
- Default activation cannot occur while admitted work is active or new work can enter.
- The fork push is the last mutating success step.

## Task 6: Exercise the admission/quiesce race and rollback boundaries

**Files**

- Add `apps/server/test/services/system/work-quiesce.test.ts`.
- Add `apps/server/test/services/system/work-quiesce-races.test.ts`.
- Add `tests/integration/fake/work-quiesce.test.ts`.
- Modify `tests/integration/vitest.config.ts` only if a separate project is required; otherwise keep the test under its existing `fake/**/*.test.ts` include.
- Extend the updater and daemon tests from Tasks 3 and 5.

**Required race tests**

1. **Quiesce wins:** for a table containing every descriptor-classified admission family and both command transports, pause admission before its immediate transaction, commit lease acquisition and establish the daemon barrier, then resume admission. Assert `work_quiesced`, no persisted admitted start, zero daemon execution/online-RPC/plugin-worker dispatch, and restart eligibility only after the post-barrier snapshot is empty.
2. **Work wins:** for each authoritative admission family, pause quiesce acquisition, commit admission first, then acquire the lease and barrier. Assert the post-acquire persisted snapshot contains that exact category and the updater records zero `systemctl restart` calls unless the explicit `--allow-active-work` confirmation is present.
3. **In-flight daemon ordering:** hold an earlier daemon start admission, deliver the barrier behind it, and assert the daemon cannot ACK until the earlier start is represented in its returned activity snapshot.
4. **Connecting daemon:** connect a new daemon after the database lease commits but before the server finishes barrier collection. Assert it starts quiesced and never becomes dispatchable in between.
5. **Ledger-before-send:** for plugin call, hook, provider installation, and another online RPC, commit the admission ledger row and pause before transport send; then acquire/barrier. Assert the snapshot sees the ledger admission and restart is refused. In the reverse ordering, assert ledger insertion fails after quiesce. With break-glass active, assert a delayed send is still rejected by the daemon gate.
6. **Partial seal:** inject failure after the `sealing` database commit, after each individual daemon seal ACK, after a daemon disconnect, and before the final `sealed` commit. Assert zero `systemctl` calls, persisted unresolved cohort state, fail-closed admission, idempotent resume, and ordered abort/recovery without deleting the database gate before reachable members unquiesce.

**Additional acceptance tests**

- A lease persists through server shutdown and recreation against the same database.
- A temporary file-backed database and two connections prove persistence and the two transaction orderings; tests do not pretend `:memory:` survives reconnection.
- Fake time proves draining expiry reopens admission, expiry between snapshot and seal prevents restart, and wall-clock expiry after seal never opens admission during activation or rollback.
- Wrong and stale operation-owner credentials cannot renew, seal, unquiesce, or release a current lease.
- TCP requests cannot reach maintenance even when their peer is loopback or they carry Tailscale/reverse-proxy forwarding headers; only the protected Unix socket with the local capability succeeds.
- Lost acquire responses are recovered by retrying the same operation ID/owner secret; a different owner cannot recover or release them.
- Owner-authenticated resume/release and capability-authenticated force-abort validate the persisted release identity; unverified rollback never releases a sealed gate.
- Two server instances cannot unlink or replace a live admin socket, and shutdown cannot unlink a replacement with a different device/inode or instance nonce.
- Two updater processes contend on the operation `flock`; the loser performs no fetch, worktree, service, plugin, prune, or push mutation.
- Queued work stays queued during maintenance and wakes exactly once after release.
- Stop, cancellation, and inspection work while admission is closed.
- A failed daemon barrier aborts activation and unwinds acknowledged daemon gates before releasing the database lease.
- Candidate health or plugin failure retains quiesce through successful rollback verification.
- Rollback failure enters `rollback-failed`; generic cleanup retains the sealed database and daemon gates until verified local recovery and never pushes.
- `--check` and `--stage-only` never acquire maintenance, change `current`, install plugins, alter systemd, prune, or push.
- Bootstrap refuses while any prior BB service/process/listener is active and succeeds only for an inactive pre-maintenance installation.
- The build sandbox cannot read the production database, admin capability, or owner files, while the resulting ARM64 artifact remains usable by the hardened service.
- The installed service keeps system directories and commit-addressed releases read-only while a service-launched process can edit a representative checkout under the user's home directory.
- The updater refuses Linux x64, macOS, dirty worktrees, ambiguous remotes, duplicate upstream/fork remotes, and non-systemd hosts.
- No push occurs before activation, identity/health checks, plugin checks, rollback checks, daemon unquiesce, and database lease release all succeed.

**Done when**

- Both transaction interleavings are deterministic tests rather than timing-based sleeps.
- The Advisor-reported window between activity check and restart is covered by a failing-before/fixed-after regression.
- The integration test demonstrates that no GUI process is required.
- Every current and future host command must be classified before the exhaustive transport test compiles/passes.

## Task 7: Document headless setup and discoverability

**Files**

- Add `docs/linux-arm64-vps.md`.
- Modify `docs/cli-guide-and-skill.md`.
- Modify the relevant `packages/templates/src/templates/bb-guide-*.md` sources.
- Modify `plugins/bb-guide/skills/bb-cli/SKILL.md` or its routed CLI reference.

**Implementation**

1. Document supported OS/architecture, Node and pnpm engine requirements, the systemd user-service install command, canonical data/release/state directories, loopback binding, BB Connect/Tailscale access, every update flag and exit code, rollback behavior, operation IDs, `--status`, JSONL logs, and journald commands.
2. Document `bb maintenance` as a local operational escape hatch over `<BB_DATA_DIR>/admin/maintenance.sock`, including socket/capability permissions, lease ownership, expiry, retryable work rejection, and the rule that operators must not release a lease owned by a running updater. State explicitly that the capability must never be copied into proxy configuration and Tailscale Serve and other TCP proxies cannot reach the route.
3. Add the CLI command family to generated guide sources and the BB CLI skill so `bb guide` and agent-facing help expose the same surface.
4. State that `--allow-active-work` is break-glass behavior for threads, terminals, provisioning, agents, workflows, goals, commands, hooks, provider installation, clones, plugin calls/workers, and future descriptor-classified starts, while still blocking all new work during restart.
5. Document the draining TTL default/minimum/maximum, the fail-closed meaning of sealed activation, how owner-file recovery works after a lost response, and the forced-recovery confirmation when the owner file is unavailable.
6. Include a copy-pasteable recovery matrix for an unavailable admin socket, dead candidate, interrupted updater, and failed rollback. Commands must inspect the operation record, `readlink` the exact `current` path, list commit-addressed releases, read `journalctl --user -u bb-local.service`, restore the recorded previous target with an atomic temporary symlink/rename helper, restart the unit, verify build identity, and only then resolve retained maintenance.
7. Document the minimum maintenance protocol version and the inactive-service-only `--bootstrap` path from older releases. A generic socket error is not an acceptable bootstrap diagnostic.
8. Document how the canonical data directory is shared by systemd and SSH sessions, how `--data-dir` validates it, how to change it through the installer, and which resolved non-secret paths diagnostics print.
9. Detect user lingering during install and show `sudo loginctl enable-linger <user>` as the exact optional-admin remediation rather than assuming it is already enabled.

**Done when**

- A new ARM64 VPS can be installed, updated, inspected, and recovered using only SSH and CLI commands.
- CLI help, `bb guide`, SDK types, and the operational guide agree on maintenance semantics.

## Verification gate

Run focused checks after each task, then the complete gate from the repository root:

```sh
pnpm --filter @bb/db db:generate
pnpm exec turbo run test --filter=@bb/db
pnpm exec turbo run test --filter=@bb/config
pnpm exec turbo run test --filter=@bb/host-daemon-contract
pnpm exec turbo run test --filter=@bb/host-daemon
pnpm exec turbo run test --filter=@bb/server
pnpm exec turbo run test --filter=@bb/sdk
pnpm exec turbo run test --filter=@bb/cli
pnpm exec turbo run test --filter=@bb/integration-tests
pnpm exec turbo run test --filter=bb-app
node --test scripts/update-local-desktop.test.mjs
node --test scripts/update-local-vps.test.mjs
node --test scripts/install-local-vps-service.test.mjs
pnpm exec turbo run typecheck --filter=@bb/db --filter=@bb/config --filter=@bb/host-daemon-contract --filter=@bb/host-daemon --filter=@bb/server --filter=@bb/sdk --filter=@bb/cli --filter=@bb/integration-tests --filter=bb-app
pnpm exec turbo run build --filter=bb-app
pnpm --filter bb-app smoke:tarball
pnpm vps:local:update --check
ripwire . --quality-delta
ripwire . --test-gate
```

Run the final packaging, tarball smoke, systemd activation, restart, and rollback acceptance checks on a real Linux ARM64 VPS. Local macOS unit tests prove orchestration logic but do not prove native ARM64 packaging or systemd behavior.

## Out of scope

- Exposing the BB server directly to the public internet.
- Supporting Linux x64 or non-systemd init systems in the first VPS updater.
- Replacing BB Connect or Tailscale with a new ingress layer.
- Live migration of active runtimes across a server restart.
- Making the running BB server mutate or rebase its own source checkout.
