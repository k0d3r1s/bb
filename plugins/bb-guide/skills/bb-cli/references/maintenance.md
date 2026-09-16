# Headless maintenance

Use `bb maintenance` only on the server host. It talks to the protected Unix socket under the selected BB data directory and cannot be routed through the normal TCP server. Protocol `2` identity reports the canonical runtime release and connected host daemons used for activation checks.

Acquire generates an operation ID and restrictive owner file. Use `identity` to verify the local protocol, `status` to inspect activity, `renew` only while draining, `seal` before restart, `transition` during activation or rollback, and `release` only after verified success or rollback. `recover` requires the matching owner file and force-aborts only draining, sealing, or rollback-failed leases; sealed activation phases require updater-owned rollback recovery. Never expose the capability or owner secret and never release or recover a running updater's operation.

Draining TTL is 30000 through 1800000 ms and defaults to 300000 ms. Draining expiry fails open; sealing and later phases remain fail-closed. `--allow-active-work` accepts reported active work but never permits new work through the barrier.

See `docs/linux-arm64-vps.md` for `pnpm vps:local:service-install`, `pnpm vps:local:update`, operation records, exit codes, journald commands, bootstrap constraints, and rollback recovery.
