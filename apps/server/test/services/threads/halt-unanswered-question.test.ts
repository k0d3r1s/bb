import { describe, expect, it } from "vitest";
import { getThread } from "@bb/db";
import type { AppDeps } from "../../../src/types.js";
import { haltThreadForUnansweredQuestion } from "../../../src/services/threads/thread-lifecycle.js";
import { seedThreadFixture } from "../../helpers/seed.js";
import { withTestHarness } from "../../helpers/test-app.js";

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function requestInteraction(
  deps: AppDeps,
  threadId: string,
  origin: { pluginId: string; rendererId: string },
): void {
  void deps.pendingInteractions.requestPluginInteraction({
    pluginId: origin.pluginId,
    threadId,
    rendererId: origin.rendererId,
    title: "Request input",
    payload: {},
    presentation: {
      label: { pending: "Waiting", completed: "Submitted" },
      icon: { glyph: "MessageQuestion" },
    },
    describeSubmission: null,
    timeoutMs: 60_000,
  });
}

function settle(
  deps: AppDeps,
  threadId: string,
  reason: "timeout" | "user",
): void {
  const [pending] =
    deps.pendingInteractions.listPendingThreadInteractions(threadId);
  if (!pending) {
    throw new Error("expected a pending interaction");
  }
  deps.pendingInteractions.cancelPluginInteraction({
    interactionId: pending.id,
    threadId,
    reason,
  });
}

describe("haltThreadForUnansweredQuestion", () => {
  const askOrigin = {
    pluginId: "ask-user-question",
    rendererId: "ask-user-question",
  };

  it("stops a live turn when an AskUserQuestion times out", async () => {
    await withTestHarness(async (harness) => {
      const deps = harness.deps;
      deps.pendingInteractions.setThreadInteractionSettledListener((i) =>
        haltThreadForUnansweredQuestion(deps, i),
      );
      const { thread } = seedThreadFixture(harness, {
        thread: { status: "active" },
      });
      requestInteraction(deps, thread.id, askOrigin);
      settle(deps, thread.id, "timeout");
      await flushMicrotasks();
      expect(getThread(deps.db, thread.id)?.status).toBe("stopping");
    });
  });

  it("does not stop the turn when the user explicitly declines", async () => {
    await withTestHarness(async (harness) => {
      const deps = harness.deps;
      deps.pendingInteractions.setThreadInteractionSettledListener((i) =>
        haltThreadForUnansweredQuestion(deps, i),
      );
      const { thread } = seedThreadFixture(harness, {
        thread: { status: "active" },
      });
      requestInteraction(deps, thread.id, askOrigin);
      settle(deps, thread.id, "user");
      await flushMicrotasks();
      expect(getThread(deps.db, thread.id)?.status).toBe("active");
    });
  });

  it("does not stop an idle thread on timeout", async () => {
    await withTestHarness(async (harness) => {
      const deps = harness.deps;
      deps.pendingInteractions.setThreadInteractionSettledListener((i) =>
        haltThreadForUnansweredQuestion(deps, i),
      );
      const { thread } = seedThreadFixture(harness, {
        thread: { status: "idle" },
      });
      requestInteraction(deps, thread.id, askOrigin);
      settle(deps, thread.id, "timeout");
      await flushMicrotasks();
      expect(getThread(deps.db, thread.id)?.status).toBe("idle");
    });
  });

  it("does not stop the turn for a non-AskUserQuestion timeout", async () => {
    await withTestHarness(async (harness) => {
      const deps = harness.deps;
      deps.pendingInteractions.setThreadInteractionSettledListener((i) =>
        haltThreadForUnansweredQuestion(deps, i),
      );
      const { thread } = seedThreadFixture(harness, {
        thread: { status: "active" },
      });
      requestInteraction(deps, thread.id, {
        pluginId: "secrets",
        rendererId: "secret-request",
      });
      settle(deps, thread.id, "timeout");
      await flushMicrotasks();
      expect(getThread(deps.db, thread.id)?.status).toBe("active");
    });
  });

  it("does not stop the turn for another plugin using the same renderer id", async () => {
    await withTestHarness(async (harness) => {
      const deps = harness.deps;
      deps.pendingInteractions.setThreadInteractionSettledListener((i) =>
        haltThreadForUnansweredQuestion(deps, i),
      );
      const { thread } = seedThreadFixture(harness, {
        thread: { status: "active" },
      });
      requestInteraction(deps, thread.id, {
        pluginId: "other-plugin",
        rendererId: "ask-user-question",
      });
      settle(deps, thread.id, "timeout");
      await flushMicrotasks();
      expect(getThread(deps.db, thread.id)?.status).toBe("active");
    });
  });
});
