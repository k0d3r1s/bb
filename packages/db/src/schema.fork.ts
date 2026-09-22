import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const workQuiescePhaseValues = [
  "draining",
  "sealing",
  "sealed",
  "activating",
  "verifying",
  "rolling-back",
  "rollback-failed",
  "releasing",
] as const;
export type WorkQuiescePhase = (typeof workQuiescePhaseValues)[number];

export const workQuiesce = sqliteTable(
  "work_quiesce",
  {
    scope: text("scope").primaryKey().$type<"global">(),
    operationId: text("operation_id").notNull(),
    ownerSecretHash: text("owner_secret_hash").notNull(),
    reason: text("reason").notNull(),
    phase: text("phase").$type<WorkQuiescePhase>().notNull(),
    acquiredAt: integer("acquired_at").notNull(),
    expiresAt: integer("expires_at"),
    candidateRelease: text("candidate_release"),
    previousRelease: text("previous_release"),
    cohortJson: text("cohort_json").notNull().default("[]"),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("work_quiesce_operation_id_unique").on(table.operationId),
    check("work_quiesce_global_scope", sql`${table.scope} = 'global'`),
    check(
      "work_quiesce_operation_id_nonempty",
      sql`length(${table.operationId}) > 0`,
    ),
    check(
      "work_quiesce_owner_secret_hash_nonempty",
      sql`length(${table.ownerSecretHash}) > 0`,
    ),
    check("work_quiesce_reason_nonempty", sql`length(${table.reason}) > 0`),
    check(
      "work_quiesce_phase_valid",
      sql`${table.phase} in ('draining', 'sealing', 'sealed', 'activating', 'verifying', 'rolling-back', 'rollback-failed', 'releasing')`,
    ),
  ],
);

export const workAdmissionStateValues = [
  "pending",
  "active",
  "settled",
] as const;
export type WorkAdmissionState = (typeof workAdmissionStateValues)[number];

export const workAdmissions = sqliteTable(
  "work_admissions",
  {
    id: text("id").primaryKey(),
    commandType: text("command_type").notNull(),
    transport: text("transport").$type<"settled" | "onlineRpc">().notNull(),
    hostId: text("host_id"),
    contextJson: text("context_json").notNull().default("{}"),
    state: text("state").$type<WorkAdmissionState>().notNull(),
    createdAt: integer("created_at").notNull(),
    settledAt: integer("settled_at"),
  },
  (table) => [
    index("work_admissions_state_idx").on(table.state),
    index("work_admissions_host_id_idx").on(table.hostId),
    check(
      "work_admissions_transport_valid",
      sql`${table.transport} in ('settled', 'onlineRpc')`,
    ),
    check(
      "work_admissions_state_valid",
      sql`${table.state} in ('pending', 'active', 'settled')`,
    ),
  ],
);

export const workQuiesceResolutions = sqliteTable("work_quiesce_resolutions", {
  operationId: text("operation_id").primaryKey(),
  resolution: text("resolution")
    .$type<"completed" | "rolled-back" | "force-aborted">()
    .notNull(),
  resolvedAt: integer("resolved_at").notNull(),
});
