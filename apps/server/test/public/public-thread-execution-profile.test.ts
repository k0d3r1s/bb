import {
  setThreadExecutionOverride,
  upsertThreadExecutionReport,
} from "@bb/db";
import { encodeClientTurnRequestIdNumber, threadScope } from "@bb/domain";
import { threadExecutionProfileResponseSchema } from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import { readJson } from "../helpers/json.js";
import { seedEvent, seedThreadFixture } from "../helpers/seed.js";
import { withTestHarness } from "../helpers/test-app.js";
describe("thread execution profile", () => {
  it("separates the last request, the stored overrides and the next turn", async () => {
    await withTestHarness(async (harness) => {
      const { environment, thread } = seedThreadFixture(harness);
      seedEvent(harness.deps, {
        threadId: thread.id,
        environmentId: environment.id,
        sequence: 1,
        type: "client/turn/requested",
        scope: threadScope(),
        data: {
          direction: "outbound",
          requestId: encodeClientTurnRequestIdNumber({ value: 7 }),
          input: [{ type: "text", text: "go" }],
          target: { kind: "new-turn" },
          execution: {
            model: "gpt-4o-mini",
            reasoningLevel: "medium",
            permissionMode: "full",
            serviceTier: "fast",
            source: "client/turn/requested",
          },
          initiator: "user",
          senderThreadId: null,
          request: { method: "turn/start", params: {} },
          source: "tell",
        },
      });
      setThreadExecutionOverride(harness.db, {
        threadId: thread.id,
        reasoningLevelOverride: "max",
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/execution-profile`,
      );
      expect(response.status).toBe(200);
      const profile = threadExecutionProfileResponseSchema.parse(
        await readJson(response),
      );

      expect(profile.lastRequested).toMatchObject({
        model: "gpt-4o-mini",
        reasoningLevel: "medium",
      });
      expect(profile.overrides).toEqual({ model: null, reasoningLevel: "max" });
      expect(profile.nextTurn).toMatchObject({ reasoningLevel: "max" });
      expect(profile.executed).toBeNull();
    });
  });

  it("reports no request and no overrides for a thread that never ran", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/execution-profile`,
      );
      const profile = threadExecutionProfileResponseSchema.parse(
        await readJson(response),
      );

      expect(profile.lastRequested).toBeNull();
      expect(profile.overrides).toEqual({ model: null, reasoningLevel: null });
      expect(profile.executed).toBeNull();
    });
  });

  it("returns the executed profile with the time it was reported", async () => {
    await withTestHarness(async (harness) => {
      const { thread } = seedThreadFixture(harness);
      upsertThreadExecutionReport(harness.db, {
        threadId: thread.id,
        execution: {
          model: "gpt-5.5-mini",
          reasoningLevel: "medium",
          permissionMode: "auto",
          serviceTier: "fast",
        },
        reportedAt: 1_760_000_000_000,
      });

      const response = await harness.app.request(
        `/api/v1/threads/${thread.id}/execution-profile`,
      );
      expect(response.status).toBe(200);
      const profile = threadExecutionProfileResponseSchema.parse(
        await readJson(response),
      );

      expect(profile.executed).toEqual({
        model: "gpt-5.5-mini",
        reasoningLevel: "medium",
        permissionMode: "auto",
        serviceTier: "fast",
        reportedAt: 1_760_000_000_000,
      });
    });
  });
});
