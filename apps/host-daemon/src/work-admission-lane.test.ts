import { describe, expect, it } from "vitest";
import { createDeferredPromise } from "@bb/test-helpers";
import { WorkAdmissionLane } from "./work-admission-lane.js";

const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe("WorkAdmissionLane", () => {
  it("runs shared work concurrently without blocking on each other", async () => {
    const lane = new WorkAdmissionLane();
    const releaseA = createDeferredPromise<void>();
    const releaseB = createDeferredPromise<void>();
    const order: string[] = [];

    const a = lane.runShared(async () => {
      order.push("a-start");
      await releaseA.promise;
      order.push("a-end");
    });
    const b = lane.runShared(async () => {
      order.push("b-start");
      await releaseB.promise;
      order.push("b-end");
    });

    await flush();
    expect(order).toEqual(["a-start", "b-start"]);

    releaseB.resolve();
    releaseA.resolve();
    await Promise.all([a, b]);
    expect(order.slice(0, 2)).toEqual(["a-start", "b-start"]);
    expect(order).toContain("a-end");
    expect(order).toContain("b-end");
  });

  it("makes an exclusive drain all in-flight shared, then run alone", async () => {
    const lane = new WorkAdmissionLane();
    const releaseFirst = createDeferredPromise<void>();
    const releaseSecond = createDeferredPromise<void>();
    const order: string[] = [];

    const first = lane.runShared(async () => {
      order.push("shared-1-start");
      await releaseFirst.promise;
      order.push("shared-1-end");
    });
    const second = lane.runShared(async () => {
      order.push("shared-2-start");
      await releaseSecond.promise;
      order.push("shared-2-end");
    });
    await flush();

    let exclusiveRan = false;
    const exclusive = lane.runExclusive(() => {
      exclusiveRan = true;
      order.push("exclusive");
    });

    await flush();
    expect(exclusiveRan).toBe(false);

    releaseFirst.resolve();
    await flush();
    expect(exclusiveRan).toBe(false);

    releaseSecond.resolve();
    await Promise.all([first, second, exclusive]);
    expect(order).toEqual([
      "shared-1-start",
      "shared-2-start",
      "shared-1-end",
      "shared-2-end",
      "exclusive",
    ]);
  });

  it("blocks shared enqueued after an exclusive until it completes", async () => {
    const lane = new WorkAdmissionLane();
    const releaseExclusive = createDeferredPromise<void>();
    const order: string[] = [];

    const exclusive = lane.runExclusive(async () => {
      order.push("exclusive-start");
      await releaseExclusive.promise;
      order.push("exclusive-end");
    });
    let sharedRan = false;
    const shared = lane.runShared(() => {
      sharedRan = true;
      order.push("shared");
    });

    await flush();
    expect(sharedRan).toBe(false);
    expect(order).toEqual(["exclusive-start"]);

    releaseExclusive.resolve();
    await Promise.all([exclusive, shared]);
    expect(order).toEqual(["exclusive-start", "exclusive-end", "shared"]);
  });

  it("does not let shared enqueued after an exclusive starve it", async () => {
    const lane = new WorkAdmissionLane();
    const releaseFirst = createDeferredPromise<void>();
    const order: string[] = [];

    const first = lane.runShared(async () => {
      order.push("first-shared");
      await releaseFirst.promise;
    });
    await flush();

    const exclusive = lane.runExclusive(() => {
      order.push("exclusive");
    });
    const late = lane.runShared(() => {
      order.push("late-shared");
    });

    await flush();
    expect(order).toEqual(["first-shared"]);

    releaseFirst.resolve();
    await Promise.all([first, exclusive, late]);
    expect(order).toEqual(["first-shared", "exclusive", "late-shared"]);
  });

  it("keeps serving work after a shared or exclusive rejects", async () => {
    const lane = new WorkAdmissionLane();

    await expect(
      lane.runShared(() => {
        throw new Error("shared failed");
      }),
    ).rejects.toThrow("shared failed");

    await expect(
      lane.runExclusive(() => {
        throw new Error("exclusive failed");
      }),
    ).rejects.toThrow("exclusive failed");

    await expect(lane.runShared(() => "shared-ok")).resolves.toBe("shared-ok");
    await expect(lane.runExclusive(() => "exclusive-ok")).resolves.toBe(
      "exclusive-ok",
    );
  });
});
