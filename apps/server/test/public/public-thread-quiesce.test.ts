import {
  acquireWorkQuiesceLease,
  getThread,
  listEvents,
  listQueuedThreadMessages,
} from "@bb/db";
import { apiErrorSchema } from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import { listQueuedThreadCommands } from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import { seedQueuedMessage, seedThreadFixture } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";

function closeWorkAdmission(db: Parameters<typeof acquireWorkQuiesceLease>[0]) {
  return acquireWorkQuiesceLease(db, {
    operationId: "update-thread-admission",
    ownerSecretHash: "owner-hash",
    reason: "VPS update",
    now: Date.now(),
    expiresAt: Date.now() + 60_000,
  });
}

describe("thread work quiesce admission", () => {
  it("rejects a direct send before persisting or starting it", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness, {
        thread: { status: "idle" },
      });
      const eventCount = listEvents(harness.db, { threadId: thread.id }).length;
      closeWorkAdmission(harness.db);

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            input: [{ type: "text", text: "Do not start during maintenance" }],
            mode: "start",
            model: "gpt-5",
            permissionMode: "full",
            reasoningLevel: "medium",
            serviceTier: "default",
          }),
        },
      );

      expect(response.status).toBe(503);
      expect(apiErrorSchema.parse(await readJson(response))).toMatchObject({
        code: "work_quiesced",
        retryable: true,
        details: { operationId: "update-thread-admission" },
      });
      expect(listEvents(harness.db, { threadId: thread.id })).toHaveLength(
        eventCount,
      );
      expect(getThread(harness.db, thread.id)?.status).toBe("idle");
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toEqual([]);
    });
  });

  it("returns a claimed queued message to the queue when admission closes", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness, {
        thread: { status: "idle" },
      });
      const queued = seedQueuedMessage(harness.deps, {
        content: [{ type: "text", text: "Keep me queued", mentions: [] }],
        threadId: thread.id,
      });
      const eventCount = listEvents(harness.db, { threadId: thread.id }).length;
      closeWorkAdmission(harness.db);

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/queued-messages/${queued.id}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mode: "auto" }),
        },
      );

      expect(response.status).toBe(503);
      expect(apiErrorSchema.parse(await readJson(response))).toMatchObject({
        code: "work_quiesced",
        retryable: true,
      });
      expect(
        listQueuedThreadMessages(harness.db, thread.id).map((row) => row.id),
      ).toEqual([queued.id]);
      expect(listEvents(harness.db, { threadId: thread.id })).toHaveLength(
        eventCount,
      );
      expect(getThread(harness.db, thread.id)?.status).toBe("idle");
      expect(
        listQueuedThreadCommands(harness, "turn.submit", thread.id),
      ).toEqual([]);
    });
  });
});
