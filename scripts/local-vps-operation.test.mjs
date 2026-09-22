import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createVpsOperationStore } from "./local-vps-operation.mjs";

test("operation transitions are durable, restrictive, and append-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "bb-vps-operation-"));
  const store = await createVpsOperationStore({
    updatesDir: root,
    operationId: "op-1",
    now: () => 42,
  });
  await store.transition("validating", {
    candidate: null,
    dataDir: "/srv/bb-data",
  });
  await assert.rejects(
    store.transition("building", { dataDir: "/srv/other" }),
    /data directory cannot change/u,
  );
  await store.transition("building", { candidate: "abc" });
  await store.transition("draining");
  await store.transition("sealing");
  await store.transition("sealed");
  await store.transition("activating");
  await store.transition("verifying");
  await store.transition("plugins");
  await store.transition("rolling-back");
  await store.transition("rollback-verified");
  await store.transition("releasing");
  await store.transition("pruning");
  await assert.rejects(
    store.transition("plugins"),
    /cannot transition from pruning to plugins/u,
  );
  assert.deepEqual(await store.read(), {
    operationId: "op-1",
    phase: "pruning",
    updatedAt: 42,
    dataDir: "/srv/bb-data",
  });
  assert.equal((await stat(store.recordPath)).mode & 0o777, 0o600);
  assert.equal((await stat(store.logPath)).mode & 0o777, 0o600);
  assert.equal(
    (await readFile(store.logPath, "utf8")).trim().split("\n").length,
    12,
  );
});
