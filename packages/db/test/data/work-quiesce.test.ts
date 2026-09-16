import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as dbApi from "../../src/index.js";
import {
  acquireWorkQuiesceLease,
  beginWorkQuiesceSeal,
  completeWorkQuiesceSeal,
  createConnection,
  migrate,
  readWorkQuiesceLease,
  releaseWorkQuiesceLease,
  renewDrainingWorkQuiesceLease,
  transitionWorkQuiescePhase,
  type DbConnection,
} from "../../src/index.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

const connections: DbConnection[] = [];
const temporaryDirectories: string[] = [];

const owner = {
  operationId: "update-1",
  ownerSecretHash: "owner-hash-1",
};

function acquire(db: DbConnection, now = 1_000) {
  return acquireWorkQuiesceLease(db, {
    ...owner,
    reason: "VPS update",
    now,
    expiresAt: now + 1_000,
  });
}

afterEach(() => {
  for (const db of connections.splice(0)) {
    db.$client.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("work quiesce schema", () => {
  it("migrates the global lease and admission ledger tables", () => {
    const db = createMigratedConnection();
    connections.push(db);

    const tables = db.$client
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((row) => row.name);

    expect(tables).toContain("work_quiesce");
    expect(tables).toContain("work_admissions");
  });

  it("exports the work quiesce data API", () => {
    expect("acquireWorkQuiesceLease" in dbApi).toBe(true);
    expect("admitExecutionStart" in dbApi).toBe(true);
  });
});

describe("work quiesce lease", () => {
  it("acquires once and replays only for the matching owner", () => {
    const db = createMigratedConnection();
    connections.push(db);

    expect(acquire(db)).toMatchObject({ kind: "acquired", replayed: false });
    expect(acquire(db)).toMatchObject({ kind: "acquired", replayed: true });
    expect(
      acquireWorkQuiesceLease(db, {
        operationId: owner.operationId,
        ownerSecretHash: "different-owner",
        reason: "VPS update",
        now: 1_100,
        expiresAt: 2_100,
      }),
    ).toMatchObject({ kind: "held" });
  });

  it("persists through closing and recreating the database connection", () => {
    const directory = mkdtempSync(join(tmpdir(), "bb-work-quiesce-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "bb.db");
    const first = createConnection(databasePath);
    migrate(first);
    expect(acquire(first)).toMatchObject({ kind: "acquired" });
    first.$client.close();

    const second = createConnection(databasePath);
    connections.push(second);
    expect(readWorkQuiesceLease(second, 1_100)).toMatchObject({
      operationId: owner.operationId,
      phase: "draining",
    });
  });

  it("lets an expired draining lease be atomically replaced", () => {
    const db = createMigratedConnection();
    connections.push(db);
    acquire(db);

    const replacement = acquireWorkQuiesceLease(db, {
      operationId: "update-2",
      ownerSecretHash: "owner-hash-2",
      reason: "replacement",
      now: 2_001,
      expiresAt: 3_001,
    });

    expect(replacement).toMatchObject({
      kind: "acquired",
      replayed: false,
      lease: { operationId: "update-2" },
    });
  });

  it("seals fail closed and enforces owner and phase transitions", () => {
    const db = createMigratedConnection();
    connections.push(db);
    acquire(db);

    expect(
      renewDrainingWorkQuiesceLease(db, {
        operationId: owner.operationId,
        ownerSecretHash: "wrong",
        now: 1_100,
        expiresAt: 2_100,
      }),
    ).toBeNull();
    expect(
      beginWorkQuiesceSeal(db, {
        ...owner,
        now: 1_100,
        cohortJson: '["host-1"]',
        candidateRelease: "candidate",
        previousRelease: "previous",
      }),
    ).toMatchObject({ phase: "sealing", expiresAt: null });
    expect(readWorkQuiesceLease(db, Number.MAX_SAFE_INTEGER)).toMatchObject({
      phase: "sealing",
    });
    expect(
      transitionWorkQuiescePhase(db, {
        ...owner,
        expectedPhase: "sealing",
        phase: "activating",
        now: 1_200,
      }),
    ).toBeNull();
    expect(completeWorkQuiesceSeal(db, { ...owner, now: 1_200 })).toMatchObject({
      phase: "sealed",
    });
    expect(
      releaseWorkQuiesceLease(db, {
        ...owner,
        resolution: "completed",
        now: 1_300,
      }),
    ).toBe(false);
  });

  it("releases only from releasing for the matching owner", () => {
    const db = createMigratedConnection();
    connections.push(db);
    acquire(db);
    expect(
      transitionWorkQuiescePhase(db, {
        ...owner,
        expectedPhase: "draining",
        phase: "releasing",
        now: 1_100,
      }),
    ).toMatchObject({ phase: "releasing" });
    expect(
      releaseWorkQuiesceLease(db, {
        operationId: owner.operationId,
        ownerSecretHash: "wrong",
        resolution: "force-aborted",
        now: 1_200,
      }),
    ).toBe(false);
    expect(
      releaseWorkQuiesceLease(db, {
        ...owner,
        resolution: "force-aborted",
        now: 1_200,
      }),
    ).toBe(true);
    expect(readWorkQuiesceLease(db, 1_200)).toBeNull();
  });
});
