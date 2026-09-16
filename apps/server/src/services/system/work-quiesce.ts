import { createHash } from "node:crypto";
import {
  acquireWorkQuiesceLease,
  beginWorkQuiesceSeal,
  clearStaleWorkAdmissions,
  completeWorkQuiesceSeal,
  listOpenWorkAdmissions,
  listRunningThreads,
  listTerminalSessions,
  ownsWorkQuiesceLease,
  readWorkQuiesceLease,
  releaseWorkQuiesceLease,
  renewDrainingWorkQuiesceLease,
  transitionWorkQuiescePhase,
  type DbConnection,
  type WorkQuiesceLease,
} from "@bb/db";
import type {
  HostDaemonCommand,
  HostDaemonCommandResultForCommand,
} from "@bb/host-daemon-contract";
import type {
  MaintenanceAcquireResponse,
  MaintenanceActivity,
  MaintenanceBarrierHost,
  MaintenanceStatusResponse,
} from "@bb/server-contract";

type WorkBarrierCommand = Extract<
  HostDaemonCommand,
  { type: "work.quiesce" | "work.seal" | "work.unquiesce" }
>;
type WorkBarrierResult = HostDaemonCommandResultForCommand<WorkBarrierCommand>;

interface BarrierState extends MaintenanceBarrierHost {
  activity: MaintenanceActivity;
}

export interface WorkQuiesceBarrierTransport {
  listConnectedHostIds(): string[];
  send(hostId: string, command: WorkBarrierCommand): Promise<WorkBarrierResult>;
}

export interface WorkQuiesceLocalBarrier {
  quiesce(): Promise<void>;
  release(): void;
}

export interface WorkQuiesceServiceOptions {
  db: DbConnection;
  local?: WorkQuiesceLocalBarrier;
  transport: WorkQuiesceBarrierTransport;
}

export class WorkQuiesceServiceError extends Error {
  constructor(
    readonly code:
      | "active_work"
      | "barrier_failed"
      | "lease_held"
      | "stale_owner"
      | "invalid_phase",
    message: string,
  ) {
    super(message);
    this.name = "WorkQuiesceServiceError";
  }
}

export function hashWorkQuiesceOwnerSecret(ownerSecret: string): string {
  return createHash("sha256").update(ownerSecret).digest("hex");
}

function publicLease(lease: WorkQuiesceLease) {
  return {
    operationId: lease.operationId,
    reason: lease.reason,
    phase: lease.phase,
    acquiredAt: lease.acquiredAt,
    expiresAt: lease.expiresAt,
    candidateRelease: lease.candidateRelease,
    previousRelease: lease.previousRelease,
  };
}

function emptyActivity(): MaintenanceActivity {
  return { activeByKind: {} };
}

function addActivity(
  target: MaintenanceActivity,
  source: MaintenanceActivity,
): void {
  for (const [kind, count] of Object.entries(source.activeByKind)) {
    target.activeByKind[kind] = (target.activeByKind[kind] ?? 0) + count;
  }
}

export class WorkQuiesceService {
  private readonly barrierByHost = new Map<string, BarrierState>();
  private daemonRegistrationGeneration = 0;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: WorkQuiesceServiceOptions) {
    clearStaleWorkAdmissions(options.db);
  }

  async acquire(input: {
    operationId: string;
    ownerSecret: string;
    reason: string;
    ttlMs: number;
    now?: number;
  }): Promise<MaintenanceAcquireResponse> {
    return this.runExclusive(() => this.acquireExclusive(input));
  }

  private async acquireExclusive(input: {
    operationId: string;
    ownerSecret: string;
    reason: string;
    ttlMs: number;
    now?: number;
  }): Promise<MaintenanceAcquireResponse> {
    const now = input.now ?? Date.now();
    const ownerSecretHash = hashWorkQuiesceOwnerSecret(input.ownerSecret);
    const acquired = acquireWorkQuiesceLease(this.options.db, {
      operationId: input.operationId,
      ownerSecretHash,
      reason: input.reason,
      now,
      expiresAt: now + input.ttlMs,
    });
    if (acquired.kind === "held") {
      throw new WorkQuiesceServiceError(
        "lease_held",
        `work maintenance is held by ${acquired.lease.operationId}`,
      );
    }
    await this.options.local?.quiesce();
    await this.establishBarrier(acquired.lease, ownerSecretHash);
    return {
      ...(await this.status(now)),
      replayed: acquired.replayed,
    };
  }

  renew(input: {
    operationId: string;
    ownerSecret: string;
    ttlMs: number;
    now?: number;
  }): WorkQuiesceLease {
    const now = input.now ?? Date.now();
    const lease = renewDrainingWorkQuiesceLease(this.options.db, {
      operationId: input.operationId,
      ownerSecretHash: hashWorkQuiesceOwnerSecret(input.ownerSecret),
      now,
      expiresAt: now + input.ttlMs,
    });
    if (!lease) {
      throw new WorkQuiesceServiceError(
        "stale_owner",
        "work maintenance renewal did not match an active draining lease",
      );
    }
    return lease;
  }

  async seal(input: {
    operationId: string;
    ownerSecret: string;
    candidateRelease: string;
    previousRelease: string;
    allowActiveWork: boolean;
    now?: number;
  }): Promise<MaintenanceStatusResponse> {
    return this.runExclusive(() => this.sealExclusive(input));
  }

  private async sealExclusive(input: {
    operationId: string;
    ownerSecret: string;
    candidateRelease: string;
    previousRelease: string;
    allowActiveWork: boolean;
    now?: number;
  }): Promise<MaintenanceStatusResponse> {
    const now = input.now ?? Date.now();
    const currentStatus = this.statusSnapshot(now);
    if (
      !input.allowActiveWork &&
      Object.values(currentStatus.activity.activeByKind).some(
        (count) => count > 0,
      )
    ) {
      throw new WorkQuiesceServiceError(
        "active_work",
        "active work remains after the quiesce barrier",
      );
    }
    const cohort = [...this.barrierByHost.keys()].sort();
    const sealing = beginWorkQuiesceSeal(this.options.db, {
      operationId: input.operationId,
      ownerSecretHash: hashWorkQuiesceOwnerSecret(input.ownerSecret),
      now,
      cohortJson: JSON.stringify(cohort),
      candidateRelease: input.candidateRelease,
      previousRelease: input.previousRelease,
    });
    if (!sealing) {
      throw new WorkQuiesceServiceError(
        "stale_owner",
        "work maintenance sealing did not match an active draining lease",
      );
    }
    let finalCohort = cohort;
    while (true) {
      const generation = this.daemonRegistrationGeneration;
      finalCohort = [...this.barrierByHost.keys()].sort();
      const quiesceFailures = await this.sendBarrierToHosts(finalCohort, {
        type: "work.quiesce",
        operationId: input.operationId,
        expiresAt: currentStatus.lease?.expiresAt ?? now + 60_000,
      });
      const sealFailures = await this.sendBarrierToHosts(finalCohort, {
        type: "work.seal",
        operationId: input.operationId,
      });
      if (quiesceFailures > 0 || sealFailures > 0) {
        throw new WorkQuiesceServiceError(
          "barrier_failed",
          "one or more host daemons did not seal work admission",
        );
      }
      if (generation === this.daemonRegistrationGeneration) break;
    }
    const finalStatus = this.statusSnapshot(now);
    if (
      !input.allowActiveWork &&
      Object.values(finalStatus.activity.activeByKind).some(
        (count) => count > 0,
      )
    ) {
      throw new WorkQuiesceServiceError(
        "active_work",
        "active work appeared while sealing the quiesce barrier",
      );
    }
    if (
      !completeWorkQuiesceSeal(this.options.db, {
        operationId: input.operationId,
        ownerSecretHash: hashWorkQuiesceOwnerSecret(input.ownerSecret),
        cohortJson: JSON.stringify(finalCohort),
        now,
      })
    ) {
      throw new WorkQuiesceServiceError(
        "invalid_phase",
        "work maintenance could not complete sealing",
      );
    }
    return this.status(now);
  }

  transition(input: {
    operationId: string;
    ownerSecret: string;
    expectedPhase: WorkQuiesceLease["phase"];
    phase: WorkQuiesceLease["phase"];
    now?: number;
  }): WorkQuiesceLease {
    const lease = transitionWorkQuiescePhase(this.options.db, {
      operationId: input.operationId,
      ownerSecretHash: hashWorkQuiesceOwnerSecret(input.ownerSecret),
      expectedPhase: input.expectedPhase,
      phase: input.phase,
      now: input.now ?? Date.now(),
    });
    if (!lease) {
      throw new WorkQuiesceServiceError(
        "invalid_phase",
        "work maintenance phase transition was rejected",
      );
    }
    return lease;
  }

  async release(input: {
    operationId: string;
    ownerSecret: string;
    resolution: "completed" | "rolled-back" | "force-aborted";
    now?: number;
  }): Promise<void> {
    return this.runExclusive(() => this.releaseExclusive(input));
  }

  private async releaseExclusive(input: {
    operationId: string;
    ownerSecret: string;
    resolution: "completed" | "rolled-back" | "force-aborted";
    now?: number;
  }): Promise<void> {
    const now = input.now ?? Date.now();
    const ownerSecretHash = hashWorkQuiesceOwnerSecret(input.ownerSecret);
    const current = readWorkQuiesceLease(this.options.db, now);
    if (
      !current ||
      current.operationId !== input.operationId ||
      !ownsWorkQuiesceLease(
        this.options.db,
        { operationId: input.operationId, ownerSecretHash },
        now,
      )
    ) {
      throw new WorkQuiesceServiceError(
        "stale_owner",
        "work maintenance release did not match an active lease",
      );
    }
    const resolutionPhaseIsValid =
      current.phase === "releasing" ||
      (input.resolution === "completed" && current.phase === "verifying") ||
      (input.resolution === "rolled-back" &&
        current.phase === "rolling-back") ||
      (input.resolution === "force-aborted" &&
        (current.phase === "draining" ||
          current.phase === "sealing" ||
          current.phase === "rollback-failed"));
    if (!resolutionPhaseIsValid) {
      throw new WorkQuiesceServiceError(
        "invalid_phase",
        `maintenance resolution ${input.resolution} is invalid from ${current.phase}`,
      );
    }
    if (current.phase !== "releasing") {
      const releasing = transitionWorkQuiescePhase(this.options.db, {
        operationId: input.operationId,
        ownerSecretHash,
        expectedPhase: current.phase,
        phase: "releasing",
        now,
      });
      if (!releasing) {
        throw new WorkQuiesceServiceError(
          "invalid_phase",
          "work maintenance cannot release from its current phase",
        );
      }
    }
    const cohort = this.cohortForLease(current);
    const failures = await this.sendBarrierToHosts(cohort, {
      type: "work.unquiesce",
      operationId: input.operationId,
    });
    if (failures > 0) {
      throw new WorkQuiesceServiceError(
        "barrier_failed",
        "one or more host daemons did not release work admission",
      );
    }
    if (
      !releaseWorkQuiesceLease(this.options.db, {
        operationId: input.operationId,
        ownerSecretHash,
        resolution: input.resolution,
        now,
      })
    ) {
      throw new WorkQuiesceServiceError(
        "stale_owner",
        "work maintenance lease changed before release",
      );
    }
    this.options.local?.release();
    this.barrierByHost.clear();
  }

  async status(now = Date.now()): Promise<MaintenanceStatusResponse> {
    return this.statusSnapshot(now);
  }

  private statusSnapshot(now: number): MaintenanceStatusResponse {
    const lease = readWorkQuiesceLease(this.options.db, now);
    const activity = emptyActivity();
    for (const admission of listOpenWorkAdmissions(this.options.db)) {
      activity.activeByKind[admission.commandType] =
        (activity.activeByKind[admission.commandType] ?? 0) + 1;
    }
    const runningThreads = listRunningThreads(this.options.db).length;
    if (runningThreads > 0) activity.activeByKind.threads = runningThreads;
    const activeTerminals = listTerminalSessions(this.options.db, {
      scope: { kind: "all", statuses: ["starting", "running"] },
      visible: false,
    }).length;
    if (activeTerminals > 0) activity.activeByKind.terminals = activeTerminals;
    for (const barrier of this.barrierByHost.values()) {
      addActivity(activity, barrier.activity);
    }
    return {
      lease: lease ? publicLease(lease) : null,
      barrier: [...this.barrierByHost.values()]
        .map(({ activity: _activity, ...barrier }) => barrier)
        .sort((left, right) => left.hostId.localeCompare(right.hostId)),
      activity,
    };
  }

  async applyToConnectingDaemon(
    hostId: string,
    now = Date.now(),
  ): Promise<boolean> {
    if (readWorkQuiesceLease(this.options.db, now)) {
      this.daemonRegistrationGeneration += 1;
      this.barrierByHost.set(hostId, {
        hostId,
        state: "pending",
        error: null,
        activity: emptyActivity(),
      });
    }
    return this.runExclusive(() =>
      this.applyToConnectingDaemonExclusive(hostId, now),
    );
  }

  private async applyToConnectingDaemonExclusive(
    hostId: string,
    now: number,
  ): Promise<boolean> {
    const lease = readWorkQuiesceLease(this.options.db, now);
    if (!lease) return false;
    const expiresAt = lease.expiresAt ?? now + 60_000;
    const quiesceResult = await this.options.transport.send(hostId, {
      type: "work.quiesce",
      operationId: lease.operationId,
      expiresAt,
    });
    this.recordBarrierSuccess(hostId, "quiesced", quiesceResult);
    if (lease.phase !== "draining") {
      const sealResult = await this.options.transport.send(hostId, {
        type: "work.seal",
        operationId: lease.operationId,
      });
      this.recordBarrierSuccess(hostId, "sealed", sealResult);
    }
    return true;
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async establishBarrier(
    lease: WorkQuiesceLease,
    ownerSecretHash: string,
  ): Promise<void> {
    const hostIds = this.options.transport.listConnectedHostIds().sort();
    const failures = await this.sendBarrierToHosts(hostIds, {
      type: "work.quiesce",
      operationId: lease.operationId,
      expiresAt: lease.expiresAt ?? lease.updatedAt,
    });
    if (failures === 0) return;
    const unwindFailures = await this.sendBarrierToHosts(
      hostIds.filter(
        (hostId) => this.barrierByHost.get(hostId)?.state === "quiesced",
      ),
      { type: "work.unquiesce", operationId: lease.operationId },
    );
    transitionWorkQuiescePhase(this.options.db, {
      operationId: lease.operationId,
      ownerSecretHash,
      expectedPhase: "draining",
      phase: "releasing",
      now: Date.now(),
    });
    if (unwindFailures === 0) {
      releaseWorkQuiesceLease(this.options.db, {
        operationId: lease.operationId,
        ownerSecretHash,
        resolution: "force-aborted",
        now: Date.now(),
      });
      this.barrierByHost.clear();
    }
    throw new WorkQuiesceServiceError(
      "barrier_failed",
      "one or more host daemons did not acknowledge the work barrier",
    );
  }

  private async sendBarrierToHosts(
    hostIds: string[],
    command: WorkBarrierCommand,
  ): Promise<number> {
    const results = await Promise.all(
      hostIds.map(async (hostId) => {
        this.barrierByHost.set(hostId, {
          hostId,
          state: "pending",
          error: null,
          activity: emptyActivity(),
        });
        try {
          const result = await this.options.transport.send(hostId, command);
          const state =
            command.type === "work.quiesce"
              ? "quiesced"
              : command.type === "work.seal"
                ? "sealed"
                : "released";
          this.recordBarrierSuccess(hostId, state, result);
          return true;
        } catch (error) {
          this.barrierByHost.set(hostId, {
            hostId,
            state: "failed",
            error: error instanceof Error ? error.message : String(error),
            activity: emptyActivity(),
          });
          return false;
        }
      }),
    );
    return results.filter((succeeded) => !succeeded).length;
  }

  private recordBarrierSuccess(
    hostId: string,
    state: "quiesced" | "sealed" | "released",
    result: WorkBarrierResult,
  ): void {
    const activity = "activity" in result ? result.activity : emptyActivity();
    this.barrierByHost.set(hostId, {
      hostId,
      state,
      error: null,
      activity,
    });
  }

  private cohortForLease(lease: WorkQuiesceLease): string[] {
    if (lease.phase === "draining") {
      return [...this.barrierByHost.keys()];
    }
    try {
      const parsed: unknown = JSON.parse(lease.cohortJson);
      if (
        Array.isArray(parsed) &&
        parsed.every((hostId) => typeof hostId === "string")
      ) {
        return [...new Set([...parsed, ...this.barrierByHost.keys()])].sort();
      }
    } catch {
      return [...this.barrierByHost.keys()];
    }
    return [...this.barrierByHost.keys()];
  }
}
