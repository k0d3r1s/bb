import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection, migrate, type DbConnection } from "@bb/db";
import type { Logger } from "@bb/logger";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testLogger } from "../../helpers/test-app.js";
import { HostEnvironmentSync } from "../../../src/services/hosts/host-environment-sync.js";
import { NotificationHub } from "../../../src/ws/hub.js";
import { WorkQuiesceService } from "../../../src/services/system/work-quiesce.js";

const logger = testLogger as unknown as Logger;

describe("HostEnvironmentSync work-quiesce interaction", () => {
  let db: DbConnection;

  afterEach(() => {
    db?.$client.close();
  });

  it("defers a push made during maintenance and resends it once maintenance releases", async () => {
    db = createConnection(":memory:");
    migrate(db);
    const dataDir = await mkdtemp(join(tmpdir(), "bb-host-environment-sync-"));
    const hub = new NotificationHub();
    const sendDaemonMessage = vi.spyOn(hub, "sendDaemonMessage");
    const sync = new HostEnvironmentSync({
      db,
      hub,
      config: { dataDir },
      logger,
    });

    const quiesce = new WorkQuiesceService({
      db,
      local: {
        quiesce: async () => {},
        release: () => sync.resumeAfterQuiesce(),
      },
      transport: {
        listConnectedHostIds: () => [],
        send: async () => {
          throw new Error("no host barrier expected");
        },
      },
    });

    await quiesce.acquire({
      operationId: "update-1",
      ownerSecret: "owner-secret",
      reason: "VPS update",
      ttlMs: 60_000,
    });
    await quiesce.seal({
      operationId: "update-1",
      ownerSecret: "owner-secret",
      candidateRelease: "candidate",
      previousRelease: "previous",
      allowActiveWork: false,
    });

    hub.notifyHost("host-1", ["host-connected"]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sendDaemonMessage).not.toHaveBeenCalled();

    quiesce.transition({
      operationId: "update-1",
      ownerSecret: "owner-secret",
      expectedPhase: "sealed",
      phase: "activating",
    });
    quiesce.transition({
      operationId: "update-1",
      ownerSecret: "owner-secret",
      expectedPhase: "activating",
      phase: "verifying",
    });
    await quiesce.release({
      operationId: "update-1",
      ownerSecret: "owner-secret",
      resolution: "completed",
    });

    await vi.waitFor(() => {
      expect(sendDaemonMessage).toHaveBeenCalledWith(
        "host-1",
        expect.objectContaining({ type: "machine-environment.replace" }),
      );
    });
  });
});
