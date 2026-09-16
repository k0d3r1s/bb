export type WorkQuiesceGatePhase = "draining" | "sealed";

export interface WorkQuiesceGateState {
  operationId: string;
  phase: WorkQuiesceGatePhase;
  expiresAt: number | null;
}

export class WorkQuiesceGateError extends Error {
  constructor(
    readonly code: "work_quiesce_conflict" | "work_quiesce_owner_mismatch",
    message: string,
  ) {
    super(message);
    this.name = "WorkQuiesceGateError";
  }
}

export class WorkQuiesceGate {
  private state: WorkQuiesceGateState | null = null;

  getState(now = Date.now()): WorkQuiesceGateState | null {
    this.expireDraining(now);
    return this.state === null ? null : { ...this.state };
  }

  allowsExecutionStart(now = Date.now()): boolean {
    return this.getState(now) === null;
  }

  quiesce(
    input: { operationId: string; expiresAt: number },
    now = Date.now(),
  ): WorkQuiesceGateState {
    this.expireDraining(now);
    if (input.expiresAt <= now) {
      throw new RangeError("work quiesce expiry must be in the future");
    }
    if (this.state !== null && this.state.operationId !== input.operationId) {
      throw new WorkQuiesceGateError(
        "work_quiesce_conflict",
        `work is already quiesced by ${this.state.operationId}`,
      );
    }
    if (this.state?.phase === "sealed") return { ...this.state };
    this.state = {
      operationId: input.operationId,
      phase: "draining",
      expiresAt: input.expiresAt,
    };
    return { ...this.state };
  }

  seal(operationId: string, now = Date.now()): WorkQuiesceGateState {
    this.expireDraining(now);
    this.requireMatchingOperation(operationId);
    this.state = { operationId, phase: "sealed", expiresAt: null };
    return { ...this.state };
  }

  unquiesce(operationId: string, now = Date.now()): boolean {
    this.expireDraining(now);
    if (this.state === null) return true;
    this.requireMatchingOperation(operationId);
    this.state = null;
    return true;
  }

  private expireDraining(now: number): void {
    if (
      this.state?.phase === "draining" &&
      this.state.expiresAt !== null &&
      this.state.expiresAt <= now
    ) {
      this.state = null;
    }
  }

  private requireMatchingOperation(operationId: string): void {
    if (this.state?.operationId === operationId) return;
    throw new WorkQuiesceGateError(
      "work_quiesce_owner_mismatch",
      "work quiesce operation does not own the current gate",
    );
  }
}
