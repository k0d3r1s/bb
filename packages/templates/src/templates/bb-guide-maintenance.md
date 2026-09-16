---
kind: instruction
title: bb Guide — Maintenance
summary: Headless Linux ARM64 updates and local work-admission control.
intent: Explain the local maintenance CLI and VPS update safety boundary.
editingNotes: Keep secrets local and keep this aligned with docs/linux-arm64-vps.md.
---
Headless maintenance commands

Maintenance is a local-only operational surface on `<BB_DATA_DIR>/admin/maintenance.sock`; it is not reachable through the TCP server, BB Connect, or Tailscale Serve. Protocol `2` identity reports the canonical runtime release and connected host daemons used for activation checks. The capability and operation owner files must remain local and mode `0600`.

  bb maintenance identity                 Verify the local admin protocol
  bb maintenance status                   Show lease, daemon barriers, and work
  bb maintenance acquire --reason <text>  Acquire admission and daemon barriers
    --ttl-ms <30000-1800000>              Default 300000 milliseconds
    --operation-id <id>                   Retry a caller-generated operation
  bb maintenance renew <id>               Renew a draining lease
  bb maintenance seal <id>                Enter fail-closed restart state
    --candidate <identity> --previous <identity>
    --allow-active-work                   Break-glass active-work acceptance
  bb maintenance transition <id> <expected-phase> <phase>
  bb maintenance release <id> --resolution <completed|rolled-back|force-aborted>
  bb maintenance recover <id>             Abort draining, sealing, or rollback-failed

All commands accept `--data-dir <absolute-path>` and `--json`. Acquire writes a restrictive owner file under `<BB_DATA_DIR>/admin/operations/`. Draining expiry reopens admission. CLI recovery force-aborts only draining, sealing, or rollback-failed leases; sealed activation phases require the updater's recorded rollback recovery. Do not release or recover an operation owned by a running updater.

For Linux ARM64 service installation, updates, flags, exit codes, journald inspection, rollback, and recovery, read `docs/linux-arm64-vps.md` in the bb checkout. The updater commands are `pnpm vps:local:service-install` and `pnpm vps:local:update`.
