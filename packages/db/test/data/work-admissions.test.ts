import { afterEach, describe, expect, it } from "vitest";
import {
  acquireWorkQuiesceLease,
  admitExecutionStart,
  claimPluginScheduledRunWithAdmission,
  clearStaleWorkAdmissions,
  listPluginSchedules,
  listOpenWorkAdmissions,
  markWorkAdmissionActive,
  settleWorkAdmission,
  upsertPluginSchedule,
  type DbConnection,
} from "../../src/index.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

const connections: DbConnection[] = [];

afterEach(() => {
  for (const db of connections.splice(0)) {
    db.$client.close();
  }
});

describe("work admission ordering", () => {
  it("rejects admission without a ledger row when quiesce commits first", () => {
    const db = createMigratedConnection();
    connections.push(db);
    acquireWorkQuiesceLease(db, {
      operationId: "update-1",
      ownerSecretHash: "owner-hash",
      reason: "VPS update",
      now: 1_000,
      expiresAt: 2_000,
    });

    expect(
      admitExecutionStart(db, {
        commandType: "thread.start",
        transport: "settled",
        hostId: "host-1",
        now: 1_100,
      }),
    ).toMatchObject({
      kind: "quiesced",
      retryable: true,
      code: "work_quiesced",
    });
    expect(listOpenWorkAdmissions(db)).toEqual([]);
  });

  it("records work for the activity snapshot when admission commits first", () => {
    const db = createMigratedConnection();
    connections.push(db);
    const admission = admitExecutionStart(db, {
      commandType: "plugin.host.call",
      transport: "onlineRpc",
      hostId: "host-1",
      context: { pluginId: "plugin-1" },
      now: 1_000,
    });
    expect(admission.kind).toBe("admitted");
    if (admission.kind !== "admitted") throw new Error("expected admission");

    expect(
      acquireWorkQuiesceLease(db, {
        operationId: "update-1",
        ownerSecretHash: "owner-hash",
        reason: "VPS update",
        now: 1_100,
        expiresAt: 2_100,
      }),
    ).toMatchObject({ kind: "acquired" });
    expect(listOpenWorkAdmissions(db)).toMatchObject([
      {
        id: admission.token.id,
        commandType: "plugin.host.call",
        state: "pending",
      },
    ]);
    expect(markWorkAdmissionActive(db, admission.token)).toBe(true);
    expect(listOpenWorkAdmissions(db)).toMatchObject([
      { id: admission.token.id, state: "active" },
    ]);
    expect(settleWorkAdmission(db, admission.token, 1_200)).toBe(true);
    expect(listOpenWorkAdmissions(db)).toEqual([]);
  });

  it("orders a scheduled plugin claim atomically with maintenance closure", () => {
    const closedDb = createMigratedConnection();
    connections.push(closedDb);
    upsertPluginSchedule(closedDb, {
      pluginId: "ticker",
      name: "tick",
      cron: "*/5 * * * *",
      nextRunAt: 900,
    });
    acquireWorkQuiesceLease(closedDb, {
      operationId: "update-1",
      ownerSecretHash: "owner-hash",
      reason: "VPS update",
      now: 1_000,
      expiresAt: 2_000,
    });
    expect(
      claimPluginScheduledRunWithAdmission(closedDb, {
        pluginId: "ticker",
        name: "tick",
        expectedNextRunAt: 900,
        newNextRunAt: 1_500,
        now: 1_100,
      }),
    ).toMatchObject({ kind: "quiesced" });
    expect(listPluginSchedules(closedDb, "ticker")[0]?.nextRunAt).toBe(900);
    expect(listOpenWorkAdmissions(closedDb)).toEqual([]);

    const admittedDb = createMigratedConnection();
    connections.push(admittedDb);
    upsertPluginSchedule(admittedDb, {
      pluginId: "ticker",
      name: "tick",
      cron: "*/5 * * * *",
      nextRunAt: 900,
    });
    const admitted = claimPluginScheduledRunWithAdmission(admittedDb, {
      pluginId: "ticker",
      name: "tick",
      expectedNextRunAt: 900,
      newNextRunAt: 1_500,
      now: 1_000,
    });
    expect(admitted.kind).toBe("admitted");
    expect(listPluginSchedules(admittedDb, "ticker")[0]?.nextRunAt).toBe(
      1_500,
    );
    expect(
      acquireWorkQuiesceLease(admittedDb, {
        operationId: "update-1",
        ownerSecretHash: "owner-hash",
        reason: "VPS update",
        now: 1_100,
        expiresAt: 2_100,
      }),
    ).toMatchObject({ kind: "acquired" });
    expect(listOpenWorkAdmissions(admittedDb)).toHaveLength(1);
  });

  it("treats expired draining as open but sealing as closed", () => {
    const db = createMigratedConnection();
    connections.push(db);
    acquireWorkQuiesceLease(db, {
      operationId: "expired",
      ownerSecretHash: "owner-hash",
      reason: "VPS update",
      now: 1_000,
      expiresAt: 1_100,
    });

    expect(
      admitExecutionStart(db, {
        commandType: "thread.start",
        transport: "settled",
        now: 1_101,
      }),
    ).toMatchObject({ kind: "admitted" });
  });

  it("reconciles crash-stale admissions at process startup", () => {
    const db = createMigratedConnection();
    connections.push(db);
    const admission = admitExecutionStart(db, {
      commandType: "thread.start",
      transport: "settled",
      now: 1_000,
    });
    expect(admission.kind).toBe("admitted");
    expect(clearStaleWorkAdmissions(db)).toBe(1);
    expect(listOpenWorkAdmissions(db)).toEqual([]);
  });
});
