import { eq } from "drizzle-orm";
import type { DbConnection, DbQueryConnection } from "../connection.js";
import {
  workQuiesce,
  workQuiesceResolutions,
  type WorkQuiescePhase,
} from "../schema.js";

export interface WorkQuiesceLease {
  scope: "global";
  operationId: string;
  reason: string;
  phase: WorkQuiescePhase;
  acquiredAt: number;
  expiresAt: number | null;
  candidateRelease: string | null;
  previousRelease: string | null;
  cohortJson: string;
  updatedAt: number;
}

export type AcquireWorkQuiesceLeaseResult =
  | { kind: "acquired"; lease: WorkQuiesceLease; replayed: boolean }
  | { kind: "held"; lease: WorkQuiesceLease };

export interface WorkQuiesceOwner {
  operationId: string;
  ownerSecretHash: string;
}

export interface AcquireWorkQuiesceLeaseInput extends WorkQuiesceOwner {
  reason: string;
  now: number;
  expiresAt: number;
}

export interface BeginWorkQuiesceSealInput extends WorkQuiesceOwner {
  now: number;
  cohortJson: string;
  candidateRelease: string;
  previousRelease: string;
}

export interface TransitionWorkQuiescePhaseInput extends WorkQuiesceOwner {
  expectedPhase: WorkQuiescePhase;
  phase: WorkQuiescePhase;
  now: number;
}

export interface ReleaseWorkQuiesceLeaseInput extends WorkQuiesceOwner {
  resolution: "completed" | "rolled-back" | "force-aborted";
  now: number;
}

const allowedPhaseTransitions: Readonly<
  Record<WorkQuiescePhase, readonly WorkQuiescePhase[]>
> = {
  draining: ["sealing", "releasing"],
  sealing: ["sealed", "releasing"],
  sealed: ["activating", "rolling-back", "releasing"],
  activating: ["verifying", "rolling-back"],
  verifying: ["rolling-back", "releasing"],
  "rolling-back": ["rollback-failed", "releasing"],
  "rollback-failed": ["rolling-back", "releasing"],
  releasing: [],
};

function hasValidAcquisitionInput(input: AcquireWorkQuiesceLeaseInput): boolean {
  return (
    input.operationId.length > 0 &&
    input.ownerSecretHash.length > 0 &&
    input.reason.length > 0 &&
    Number.isSafeInteger(input.now) &&
    Number.isSafeInteger(input.expiresAt) &&
    input.expiresAt > input.now
  );
}

function toLease(row: typeof workQuiesce.$inferSelect): WorkQuiesceLease {
  return {
    scope: row.scope,
    operationId: row.operationId,
    reason: row.reason,
    phase: row.phase,
    acquiredAt: row.acquiredAt,
    expiresAt: row.expiresAt,
    candidateRelease: row.candidateRelease,
    previousRelease: row.previousRelease,
    cohortJson: row.cohortJson,
    updatedAt: row.updatedAt,
  };
}

function readLeaseRow(db: DbQueryConnection) {
  return db
    .select()
    .from(workQuiesce)
    .where(eq(workQuiesce.scope, "global"))
    .get();
}

function ownerMatches(
  row: typeof workQuiesce.$inferSelect,
  owner: WorkQuiesceOwner,
): boolean {
  return (
    row.operationId === owner.operationId &&
    row.ownerSecretHash === owner.ownerSecretHash
  );
}

function isExpiredDraining(
  row: typeof workQuiesce.$inferSelect,
  now: number,
): boolean {
  return (
    row.phase === "draining" &&
    row.expiresAt !== null &&
    row.expiresAt <= now
  );
}

export function readWorkQuiesceLease(
  db: DbQueryConnection,
  now = Date.now(),
): WorkQuiesceLease | null {
  const row = readLeaseRow(db);
  if (!row || isExpiredDraining(row, now)) return null;
  return toLease(row);
}

export function ownsWorkQuiesceLease(
  db: DbQueryConnection,
  owner: WorkQuiesceOwner,
  now = Date.now(),
): boolean {
  const row = readLeaseRow(db);
  return Boolean(row && !isExpiredDraining(row, now) && ownerMatches(row, owner));
}

export function acquireWorkQuiesceLease(
  db: DbConnection,
  input: AcquireWorkQuiesceLeaseInput,
): AcquireWorkQuiesceLeaseResult {
  if (!hasValidAcquisitionInput(input)) {
    throw new RangeError("invalid work quiesce acquisition");
  }
  return db.transaction(
    (tx) => {
      const existing = readLeaseRow(tx);
      if (existing && !isExpiredDraining(existing, input.now)) {
        if (ownerMatches(existing, input)) {
          return { kind: "acquired", lease: toLease(existing), replayed: true };
        }
        return { kind: "held", lease: toLease(existing) };
      }
      if (existing) {
        tx.delete(workQuiesce)
          .where(eq(workQuiesce.scope, "global"))
          .run();
      }
      const row: typeof workQuiesce.$inferInsert = {
        scope: "global",
        operationId: input.operationId,
        ownerSecretHash: input.ownerSecretHash,
        reason: input.reason,
        phase: "draining",
        acquiredAt: input.now,
        expiresAt: input.expiresAt,
        updatedAt: input.now,
      };
      tx.insert(workQuiesce).values(row).run();
      return {
        kind: "acquired",
        lease: toLease({
          ...row,
          expiresAt: input.expiresAt,
          candidateRelease: null,
          previousRelease: null,
          cohortJson: "[]",
        }),
        replayed: false,
      };
    },
    { behavior: "immediate" },
  );
}

export function renewDrainingWorkQuiesceLease(
  db: DbConnection,
  input: WorkQuiesceOwner & { now: number; expiresAt: number },
): WorkQuiesceLease | null {
  return db.transaction(
    (tx) => {
      const row = readLeaseRow(tx);
      if (
        !row ||
        !ownerMatches(row, input) ||
        row.phase !== "draining" ||
        isExpiredDraining(row, input.now)
      ) {
        return null;
      }
      tx.update(workQuiesce)
        .set({ expiresAt: input.expiresAt, updatedAt: input.now })
        .where(eq(workQuiesce.scope, "global"))
        .run();
      return toLease({ ...row, expiresAt: input.expiresAt, updatedAt: input.now });
    },
    { behavior: "immediate" },
  );
}

export function beginWorkQuiesceSeal(
  db: DbConnection,
  input: BeginWorkQuiesceSealInput,
): WorkQuiesceLease | null {
  return db.transaction(
    (tx) => {
      const row = readLeaseRow(tx);
      if (
        !row ||
        !ownerMatches(row, input) ||
        row.phase !== "draining" ||
        isExpiredDraining(row, input.now)
      ) {
        return null;
      }
      const next = {
        ...row,
        phase: "sealing" as const,
        expiresAt: null,
        cohortJson: input.cohortJson,
        candidateRelease: input.candidateRelease,
        previousRelease: input.previousRelease,
        updatedAt: input.now,
      };
      tx.update(workQuiesce)
        .set(next)
        .where(eq(workQuiesce.scope, "global"))
        .run();
      return toLease(next);
    },
    { behavior: "immediate" },
  );
}

export function completeWorkQuiesceSeal(
  db: DbConnection,
  input: WorkQuiesceOwner & { now: number; cohortJson?: string },
): WorkQuiesceLease | null {
  const cohortJson = input.cohortJson;
  if (cohortJson !== undefined) {
    return db.transaction(
      (tx) => {
        const row = readLeaseRow(tx);
        if (!row || !ownerMatches(row, input) || row.phase !== "sealing") {
          return null;
        }
        const next = {
          ...row,
          phase: "sealed" as const,
          cohortJson,
          updatedAt: input.now,
        };
        tx.update(workQuiesce)
          .set(next)
          .where(eq(workQuiesce.scope, "global"))
          .run();
        return toLease(next);
      },
      { behavior: "immediate" },
    );
  }
  return transitionWorkQuiescePhase(db, {
    ...input,
    expectedPhase: "sealing",
    phase: "sealed",
  });
}

export function transitionWorkQuiescePhase(
  db: DbConnection,
  input: TransitionWorkQuiescePhaseInput,
): WorkQuiesceLease | null {
  if (!allowedPhaseTransitions[input.expectedPhase].includes(input.phase)) {
    return null;
  }
  return db.transaction(
    (tx) => {
      const row = readLeaseRow(tx);
      if (
        !row ||
        !ownerMatches(row, input) ||
        row.phase !== input.expectedPhase
      ) {
        return null;
      }
      const next = { ...row, phase: input.phase, updatedAt: input.now };
      tx.update(workQuiesce)
        .set({ phase: input.phase, updatedAt: input.now })
        .where(eq(workQuiesce.scope, "global"))
        .run();
      return toLease(next);
    },
    { behavior: "immediate" },
  );
}

export function releaseWorkQuiesceLease(
  db: DbConnection,
  input: ReleaseWorkQuiesceLeaseInput,
): boolean {
  return db.transaction(
    (tx) => {
      const row = readLeaseRow(tx);
      if (
        !row ||
        !ownerMatches(row, input) ||
        row.phase !== "releasing"
      ) {
        return false;
      }
      tx.insert(workQuiesceResolutions)
        .values({
          operationId: input.operationId,
          resolution: input.resolution,
          resolvedAt: input.now,
        })
        .onConflictDoUpdate({
          target: workQuiesceResolutions.operationId,
          set: { resolution: input.resolution, resolvedAt: input.now },
        })
        .run();
      tx.delete(workQuiesce)
        .where(eq(workQuiesce.scope, "global"))
        .run();
      return true;
    },
    { behavior: "immediate" },
  );
}

export function isWorkAdmissionOpen(
  db: DbQueryConnection,
  now = Date.now(),
): boolean {
  return readWorkQuiesceLease(db, now) === null;
}
