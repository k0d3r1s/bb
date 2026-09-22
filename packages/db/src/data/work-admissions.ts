import { and, eq, ne } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { DbConnection, DbTransaction } from "../connection.js";
import { workAdmissions } from "../schema.js";
import {
  isWorkAdmissionOpen,
  readWorkQuiesceLease,
  type WorkQuiesceLease,
} from "./work-quiesce.js";

export interface WorkAdmissionToken {
  readonly kind: "work-admission";
  readonly id: string;
  readonly commandType: string;
  readonly transport: "settled" | "onlineRpc";
  readonly hostId: string | null;
}

export type AdmitExecutionStartResult =
  | { kind: "admitted"; token: WorkAdmissionToken }
  | WorkQuiescedResult;

export interface WorkQuiescedResult {
  kind: "quiesced";
  code: "work_quiesced";
  retryable: true;
  lease: WorkQuiesceLease;
}

export type WorkAdmissionOpenResult = { kind: "open" } | WorkQuiescedResult;

export interface AdmitExecutionStartInput {
  commandType: string;
  transport: "settled" | "onlineRpc";
  hostId?: string;
  context?: Record<string, unknown>;
  now?: number;
}

export function assertWorkAdmissionOpen(
  tx: DbTransaction,
  now = Date.now(),
): WorkAdmissionOpenResult {
  if (isWorkAdmissionOpen(tx, now)) return { kind: "open" };
  const lease = readWorkQuiesceLease(tx, now);
  if (!lease)
    throw new Error("work quiesce lease disappeared during admission");
  return {
    kind: "quiesced",
    code: "work_quiesced",
    retryable: true,
    lease,
  };
}

export function admitExecutionStartInTransaction(
  tx: DbTransaction,
  input: AdmitExecutionStartInput,
): AdmitExecutionStartResult {
  const now = input.now ?? Date.now();
  const admissionState = assertWorkAdmissionOpen(tx, now);
  if (admissionState.kind === "quiesced") return admissionState;
  const token: WorkAdmissionToken = {
    kind: "work-admission",
    id: nanoid(),
    commandType: input.commandType,
    transport: input.transport,
    hostId: input.hostId ?? null,
  };
  tx.insert(workAdmissions)
    .values({
      id: token.id,
      commandType: token.commandType,
      transport: token.transport,
      hostId: token.hostId,
      contextJson: JSON.stringify(input.context ?? {}),
      state: "pending",
      createdAt: now,
    })
    .run();
  return { kind: "admitted", token };
}

export function admitExecutionStart(
  db: DbConnection,
  input: AdmitExecutionStartInput,
): AdmitExecutionStartResult {
  return db.transaction((tx) => admitExecutionStartInTransaction(tx, input), {
    behavior: "immediate",
  });
}

export function markWorkAdmissionActive(
  db: DbConnection,
  token: WorkAdmissionToken,
): boolean {
  return (
    db
      .update(workAdmissions)
      .set({ state: "active" })
      .where(
        and(
          eq(workAdmissions.id, token.id),
          eq(workAdmissions.state, "pending"),
        ),
      )
      .run().changes > 0
  );
}

export function settleWorkAdmission(
  db: DbConnection,
  token: WorkAdmissionToken,
  _now = Date.now(),
): boolean {
  return (
    db
      .delete(workAdmissions)
      .where(
        and(
          eq(workAdmissions.id, token.id),
          ne(workAdmissions.state, "settled"),
        ),
      )
      .run().changes > 0
  );
}

export function clearStaleWorkAdmissions(db: DbConnection): number {
  return db.delete(workAdmissions).run().changes;
}

export function listOpenWorkAdmissions(db: DbConnection) {
  return db
    .select()
    .from(workAdmissions)
    .where(ne(workAdmissions.state, "settled"))
    .all();
}
