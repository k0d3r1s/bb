import { describe, expect, it, vi } from "vitest";
import {
  admitExecutionStart,
  createConnection,
  migrate,
  readWorkQuiesceLease,
} from "@bb/db";
import {
  WorkQuiesceService,
  hashWorkQuiesceOwnerSecret,
  type WorkQuiesceBarrierTransport,
} from "../../../src/services/system/work-quiesce.js";

function createHarness(hostIds: string[] = ["host-1"]) {
  const db = createConnection(":memory:");
  migrate(db);
  const send = vi.fn<WorkQuiesceBarrierTransport["send"]>(
    async (_hostId, command) => {
      if (command.type === "work.quiesce") {
        return {
          operationId: command.operationId,
          gatePhase: "draining",
          activity: { activeByKind: {} },
        };
      }
      if (command.type === "work.seal") {
        return {
          operationId: command.operationId,
          gatePhase: "sealed",
          activity: { activeByKind: {} },
        };
      }
      return { operationId: command.operationId, released: true };
    },
  );
  const transport: WorkQuiesceBarrierTransport = {
    listConnectedHostIds: () => hostIds,
    send,
  };
  return {
    db,
    send,
    service: new WorkQuiesceService({ db, transport }),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

describe("WorkQuiesceService", () => {
  it("clears crash-stale admissions when the service starts", async () => {
    const db = createConnection(":memory:");
    migrate(db);
    const admitted = admitExecutionStart(db, {
      commandType: "thread.start",
      transport: "settled",
      now: 900,
    });
    expect(admitted.kind).toBe("admitted");
    const service = new WorkQuiesceService({
      db,
      transport: {
        listConnectedHostIds: () => [],
        send: async () => {
          throw new Error("no connected host should receive a barrier");
        },
      },
    });
    await expect(service.status(1_000)).resolves.toMatchObject({
      activity: { activeByKind: {} },
    });
    db.$client.close();
  });

  it("acquires before barriers and returns persisted admitted activity", async () => {
    const { db, send, service } = createHarness();
    const admitted = admitExecutionStart(db, {
      commandType: "plugin.host.call",
      transport: "onlineRpc",
      hostId: "host-1",
      now: 900,
    });
    expect(admitted.kind).toBe("admitted");

    const result = await service.acquire({
      operationId: "update-1",
      ownerSecret: "owner-secret",
      reason: "VPS update",
      ttlMs: 60_000,
      now: 1_000,
    });

    expect(readWorkQuiesceLease(db, 1_001)).toMatchObject({
      operationId: "update-1",
      phase: "draining",
    });
    expect(send).toHaveBeenCalledWith(
      "host-1",
      expect.objectContaining({ type: "work.quiesce" }),
    );
    expect(result.activity.activeByKind).toMatchObject({
      "plugin.host.call": 1,
    });
    const storedOwnerHash = db.$client
      .prepare<[], { owner_secret_hash: string }>(
        "SELECT owner_secret_hash FROM work_quiesce WHERE scope = 'global'",
      )
      .get()?.owner_secret_hash;
    expect(storedOwnerHash).toBe(hashWorkQuiesceOwnerSecret("owner-secret"));
    expect(storedOwnerHash).not.toBe("owner-secret");
    db.$client.close();
  });

  it("leaves partial sealing fail closed and never reports sealed", async () => {
    const { db, send, service } = createHarness(["host-1", "host-2"]);
    await service.acquire({
      operationId: "update-1",
      ownerSecret: "owner-secret",
      reason: "VPS update",
      ttlMs: 60_000,
      now: 1_000,
    });
    send.mockImplementation(async (hostId, command) => {
      if (hostId === "host-2" && command.type === "work.seal") {
        throw new Error("host disconnected");
      }
      if (command.type === "work.quiesce") {
        return {
          operationId: command.operationId,
          gatePhase: "draining",
          activity: { activeByKind: {} },
        };
      }
      if (command.type === "work.seal") {
        return {
          operationId: command.operationId,
          gatePhase: "sealed",
          activity: { activeByKind: {} },
        };
      }
      return { operationId: command.operationId, released: true };
    });

    await expect(
      service.seal({
        operationId: "update-1",
        ownerSecret: "owner-secret",
        candidateRelease: "candidate",
        previousRelease: "previous",
        allowActiveWork: false,
        now: 1_100,
      }),
    ).rejects.toMatchObject({ code: "barrier_failed" });
    expect(readWorkQuiesceLease(db, Number.MAX_SAFE_INTEGER)).toMatchObject({
      phase: "sealing",
    });
    expect((await service.status(Number.MAX_SAFE_INTEGER)).barrier).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hostId: "host-1", state: "sealed" }),
        expect.objectContaining({ hostId: "host-2", state: "failed" }),
      ]),
    );
    db.$client.close();
  });

  it("releases daemon gates before deleting the database lease", async () => {
    const { db, send, service } = createHarness();
    await service.acquire({
      operationId: "update-1",
      ownerSecret: "owner-secret",
      reason: "VPS update",
      ttlMs: 60_000,
      now: 1_000,
    });
    await service.release({
      operationId: "update-1",
      ownerSecret: "owner-secret",
      resolution: "force-aborted",
      now: 1_100,
    });
    expect(send).toHaveBeenLastCalledWith("host-1", {
      type: "work.unquiesce",
      operationId: "update-1",
    });
    expect(readWorkQuiesceLease(db, 1_100)).toBeNull();
    db.$client.close();
  });

  it("unwinds acknowledged daemon gates and the lease when acquisition barriers fail", async () => {
    const { db, send, service } = createHarness(["host-1", "host-2"]);
    send.mockImplementation(async (hostId, command) => {
      if (hostId === "host-2" && command.type === "work.quiesce") {
        throw new Error("host disconnected");
      }
      if (command.type === "work.quiesce") {
        return {
          operationId: command.operationId,
          gatePhase: "draining",
          activity: { activeByKind: {} },
        };
      }
      if (command.type === "work.unquiesce") {
        return { operationId: command.operationId, released: true };
      }
      return {
        operationId: command.operationId,
        gatePhase: "sealed",
        activity: { activeByKind: {} },
      };
    });

    await expect(
      service.acquire({
        operationId: "update-1",
        ownerSecret: "owner-secret",
        reason: "VPS update",
        ttlMs: 60_000,
        now: 1_000,
      }),
    ).rejects.toMatchObject({ code: "barrier_failed" });
    expect(send).toHaveBeenCalledWith("host-1", {
      type: "work.unquiesce",
      operationId: "update-1",
    });
    expect(readWorkQuiesceLease(db, Date.now())).toBeNull();
    db.$client.close();
  });

  it("does not release sealed maintenance without a verified activation phase", async () => {
    const { db, service } = createHarness();
    await service.acquire({
      operationId: "update-1",
      ownerSecret: "owner-secret",
      reason: "VPS update",
      ttlMs: 60_000,
      now: 1_000,
    });
    await service.seal({
      operationId: "update-1",
      ownerSecret: "owner-secret",
      candidateRelease: "candidate",
      previousRelease: "previous",
      allowActiveWork: false,
      now: 1_100,
    });
    await expect(
      service.release({
        operationId: "update-1",
        ownerSecret: "owner-secret",
        resolution: "completed",
        now: 1_200,
      }),
    ).rejects.toMatchObject({ code: "invalid_phase" });
    expect(readWorkQuiesceLease(db, Number.MAX_SAFE_INTEGER)).toMatchObject({
      phase: "sealed",
    });
    db.$client.close();
  });

  it("releases a daemon that joined after the persisted sealing cohort", async () => {
    const { db, send, service } = createHarness(["host-1"]);
    await service.acquire({
      operationId: "update-1",
      ownerSecret: "owner-secret",
      reason: "VPS update",
      ttlMs: 60_000,
      now: 1_000,
    });
    await service.seal({
      operationId: "update-1",
      ownerSecret: "owner-secret",
      candidateRelease: "candidate",
      previousRelease: "previous",
      allowActiveWork: false,
      now: 1_100,
    });
    await service.applyToConnectingDaemon("host-2", 1_150);
    service.transition({
      operationId: "update-1",
      ownerSecret: "owner-secret",
      expectedPhase: "sealed",
      phase: "activating",
      now: 1_200,
    });
    service.transition({
      operationId: "update-1",
      ownerSecret: "owner-secret",
      expectedPhase: "activating",
      phase: "verifying",
      now: 1_300,
    });
    await service.release({
      operationId: "update-1",
      ownerSecret: "owner-secret",
      resolution: "completed",
      now: 1_400,
    });
    expect(send).toHaveBeenCalledWith("host-2", {
      type: "work.unquiesce",
      operationId: "update-1",
    });
    expect(readWorkQuiesceLease(db, 1_400)).toBeNull();
    db.$client.close();
  });

  it("includes a daemon whose draining handshake overlaps seal cohort capture", async () => {
    const { db, send, service } = createHarness(["host-1"]);
    await service.acquire({
      operationId: "update-1",
      ownerSecret: "owner-secret",
      reason: "VPS update",
      ttlMs: 60_000,
      now: 1_000,
    });
    const connectingEntered = deferred<void>();
    const finishConnecting = deferred<void>();
    send.mockImplementation(async (hostId, command) => {
      if (hostId === "host-2" && command.type === "work.quiesce") {
        connectingEntered.resolve();
        await finishConnecting.promise;
      }
      if (command.type === "work.quiesce") {
        return {
          operationId: command.operationId,
          gatePhase: "draining",
          activity: { activeByKind: {} },
        };
      }
      if (command.type === "work.seal") {
        return {
          operationId: command.operationId,
          gatePhase: "sealed",
          activity: { activeByKind: {} },
        };
      }
      return { operationId: command.operationId, released: true };
    });

    const connecting = service.applyToConnectingDaemon("host-2", 1_050);
    await connectingEntered.promise;
    const sealing = service.seal({
      operationId: "update-1",
      ownerSecret: "owner-secret",
      candidateRelease: "candidate",
      previousRelease: "previous",
      allowActiveWork: false,
      now: 1_100,
    });
    await Promise.resolve();
    expect(send).not.toHaveBeenCalledWith(
      "host-1",
      expect.objectContaining({ type: "work.seal" }),
    );

    finishConnecting.resolve();
    await connecting;
    await sealing;
    expect(send).toHaveBeenCalledWith("host-2", {
      type: "work.seal",
      operationId: "update-1",
    });
    expect(readWorkQuiesceLease(db, Number.MAX_SAFE_INTEGER)).toMatchObject({
      phase: "sealed",
      cohortJson: '["host-1","host-2"]',
    });
    db.$client.close();
  });

  it("rechecks a daemon registered after seal captures its first cohort", async () => {
    const { db, send, service } = createHarness(["host-1"]);
    await service.acquire({
      operationId: "update-1",
      ownerSecret: "owner-secret",
      reason: "VPS update",
      ttlMs: 60_000,
      now: 1_000,
    });
    const firstSealQuiesceEntered = deferred<void>();
    const finishFirstSealQuiesce = deferred<void>();
    let heldFirstSealQuiesce = false;
    send.mockImplementation(async (hostId, command) => {
      if (
        !heldFirstSealQuiesce &&
        hostId === "host-1" &&
        command.type === "work.quiesce"
      ) {
        heldFirstSealQuiesce = true;
        firstSealQuiesceEntered.resolve();
        await finishFirstSealQuiesce.promise;
      }
      const activeByKind: Record<string, number> =
        hostId === "host-2" ? { thread: 1 } : {};
      if (command.type === "work.quiesce") {
        return {
          operationId: command.operationId,
          gatePhase: "draining",
          activity: { activeByKind },
        };
      }
      if (command.type === "work.seal") {
        return {
          operationId: command.operationId,
          gatePhase: "sealed",
          activity: { activeByKind },
        };
      }
      return { operationId: command.operationId, released: true };
    });

    const sealing = service.seal({
      operationId: "update-1",
      ownerSecret: "owner-secret",
      candidateRelease: "candidate",
      previousRelease: "previous",
      allowActiveWork: false,
      now: 1_100,
    });
    await firstSealQuiesceEntered.promise;
    const connecting = service.applyToConnectingDaemon("host-2", 1_101);
    finishFirstSealQuiesce.resolve();

    await expect(sealing).rejects.toMatchObject({ code: "active_work" });
    await connecting;
    expect(send).toHaveBeenCalledWith(
      "host-2",
      expect.objectContaining({ type: "work.quiesce" }),
    );
    expect(send).toHaveBeenCalledWith("host-2", {
      type: "work.seal",
      operationId: "update-1",
    });
    expect(readWorkQuiesceLease(db, Number.MAX_SAFE_INTEGER)).toMatchObject({
      phase: "sealing",
    });
    db.$client.close();
  });

  it("rejects new admission after acquire before the durable seal", async () => {
    const { db, service } = createHarness();
    const acquired = await service.acquire({
      operationId: "update-1",
      ownerSecret: "owner-secret",
      reason: "VPS update",
      ttlMs: 60_000,
      now: 1_000,
    });
    expect(acquired.activity.activeByKind).toEqual({});

    expect(
      admitExecutionStart(db, {
        commandType: "thread.start",
        transport: "settled",
        hostId: "host-1",
        now: 1_050,
      }),
    ).toMatchObject({ kind: "quiesced", code: "work_quiesced" });
    await service.seal({
      operationId: "update-1",
      ownerSecret: "owner-secret",
      candidateRelease: "candidate",
      previousRelease: "previous",
      allowActiveWork: false,
      now: 1_100,
    });
    expect(readWorkQuiesceLease(db, Number.MAX_SAFE_INTEGER)).toMatchObject({
      phase: "sealed",
    });
    db.$client.close();
  });
});
