import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createMigratedConnection } from "../helpers/migrated-connection.js";
import { noopNotifier as hub } from "../../src/notifier.js";
import {
  createProject,
  deleteProject,
  markProjectDeleted,
} from "../../src/data/projects.js";
import { upsertHost } from "../../src/data/hosts.js";
import {
  createEnvironment,
  getEnvironment,
  markHostEnvironmentsDestroyed,
} from "../../src/data/environments.js";
import {
  archiveThread,
  createThread,
  getThread,
  markThreadDeleted,
  updateThread,
} from "../../src/data/threads.js";
import {
  getActiveBranchPromotion,
  recordBranchPromotionSnapshot,
  reserveBranchPromotion,
} from "../../src/data/branch-promotions.fork.js";
import { environments } from "../../src/schema.js";
import type { BranchPromotionSnapshot } from "@bb/domain";

function setup() {
  const db = createMigratedConnection();
  const host = upsertHost(db, hub, { name: "host" });
  const { project } = createProject(db, hub, {
    name: "project",
    source: { type: "local_path", hostId: host.id, path: "/checkout" },
  });
  const environment = createEnvironment(db, hub, {
    projectId: project.id,
    hostId: host.id,
    path: "/checkout",
    providerOwnsPath: false,
    status: "ready",
    isGitRepo: true,
    branchName: "main",
    environmentProvider: {
      environmentProviderId: "project-checkout",
      instanceKey: null,
      selection: {
        machine: { type: "existing", hostId: host.id },
        inputs: null,
      },
    },
  });
  const spawn = () =>
    createThread(db, hub, {
      projectId: project.id,
      providerId: "test",
      status: "idle",
      environmentId: environment.id,
      promotionTarget: "branch",
      worktreePromotion: "armed",
    });
  const thread = spawn();
  const reserve = () =>
    reserveBranchPromotion(db, {
      threadId: thread.id,
      environmentId: environment.id,
      hostId: host.id,
      intent: {
        operationId: randomUUID(),
        path: "/checkout",
        sourceBranch: "main",
        sourceHead: "a".repeat(40),
        target: { kind: "new", name: "bb/change" },
      },
    });
  return { db, thread, environment, reserve, spawn };
}

function result(
  operationId: string,
  patch: Partial<BranchPromotionSnapshot> = {},
): BranchPromotionSnapshot {
  return {
    operationId,
    phase: "completed",
    branchName: "bb/change",
    headSha: "a".repeat(40),
    observation: "observation",
    commandTerminated: true,
    resolution: null,
    message: null,
    replayed: false,
    ...patch,
  };
}

describe("branch promotion reservations", () => {
  it("excludes new admissions, duplicate operations, decline, reassignment, archive and deletion until settlement", () => {
    const { db, thread, environment, reserve, spawn } = setup();
    const operation = reserve();
    expect(getEnvironment(db, environment.id)?.claimPath).toBe("/checkout");
    expect(spawn).toThrow(/promotion/);
    expect(reserve).toThrow(/promotion/);
    expect(() =>
      updateThread(db, hub, thread.id, { worktreePromotion: "declined" }),
    ).toThrow(/promotion/);
    expect(() =>
      updateThread(db, hub, thread.id, { environmentId: null }),
    ).toThrow(/promotion/);
    expect(() => archiveThread(db, hub, thread.id)).toThrow(/promotion/);
    expect(() => markThreadDeleted(db, hub, { threadId: thread.id })).toThrow(
      /promotion/,
    );
    expect(() =>
      markProjectDeleted(db, hub, { projectId: thread.projectId }),
    ).toThrow(/promotion/);
    expect(() => deleteProject(db, hub, thread.projectId)).toThrow(/promotion/);
    expect(() =>
      markHostEnvironmentsDestroyed(db, hub, environment.hostId),
    ).toThrow(/promotion/);
    recordBranchPromotionSnapshot(db, hub, operation, result(operation.id));
    expect(getEnvironment(db, environment.id)).toMatchObject({
      id: environment.id,
      path: "/checkout",
      branchName: "bb/change",
      claimPath: null,
    });
    expect(getThread(db, thread.id)?.worktreePromotion).toBe("promoted");
    expect(getActiveBranchPromotion(db, thread.id)).toBeNull();
    expect(spawn().id).toBeTruthy();
    db.$client.close();
  });

  it("rejects another live thread and an existing provisioning claim", () => {
    const first = setup();
    first.spawn();
    expect(first.reserve).toThrow(/another thread/);
    first.db.$client.close();
    const second = setup();
    second.db
      .update(environments)
      .set({ claimPath: "/checkout" })
      .where(eq(environments.id, second.environment.id))
      .run();
    expect(second.reserve).toThrow(/another operation/);
    second.db.$client.close();
  });

  it("keeps uncertain and unterminated outcomes reserved and permits explicit keep-current recovery", () => {
    const { db, thread, environment, reserve } = setup();
    const operation = reserve();
    recordBranchPromotionSnapshot(
      db,
      hub,
      operation,
      result(operation.id, { phase: "uncertain", branchName: "main" }),
    );
    expect(getActiveBranchPromotion(db, thread.id)?.phase).toBe("reconciling");
    recordBranchPromotionSnapshot(
      db,
      hub,
      operation,
      result(operation.id, { commandTerminated: false }),
    );
    expect(getEnvironment(db, environment.id)?.claimPath).toBe("/checkout");
    recordBranchPromotionSnapshot(
      db,
      hub,
      operation,
      result(operation.id, {
        phase: "resolved",
        branchName: "main",
        resolution: "keep-current",
      }),
    );
    expect(getThread(db, thread.id)?.worktreePromotion).toBe("declined");
    expect(getEnvironment(db, environment.id)).toMatchObject({
      claimPath: null,
      branchName: "main",
    });
    db.$client.close();
  });

  it("leaves known failures armed and rejects wrong-operation or wrong-target completion", () => {
    const { db, thread, reserve } = setup();
    const operation = reserve();
    expect(() =>
      recordBranchPromotionSnapshot(db, hub, operation, result("other")),
    ).toThrow(/match/);
    expect(() =>
      recordBranchPromotionSnapshot(
        db,
        hub,
        operation,
        result(operation.id, { branchName: "other" }),
      ),
    ).toThrow(/moved/);
    recordBranchPromotionSnapshot(
      db,
      hub,
      operation,
      result(operation.id, { phase: "failed", branchName: "main" }),
    );
    expect(getThread(db, thread.id)?.worktreePromotion).toBe("armed");
    expect(reserve().id).not.toBe(operation.id);
    db.$client.close();
  });
});
