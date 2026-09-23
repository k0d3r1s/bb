import { eq } from "drizzle-orm";
import { events } from "@bb/db";
import { threadScope, turnScope } from "@bb/domain";
import {
  groupHostDaemonEvents,
  type HostDaemonEventEnvelope,
} from "@bb/host-daemon-contract";
import { threadExecutionProfileResponseSchema } from "@bb/server-contract";
import { describe, expect, it } from "vitest";
import { internalAuthHeaders } from "../helpers/commands.js";
import { readJson } from "../helpers/json.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedThread,
} from "../helpers/seed.js";
import { createTestAppHarness } from "../helpers/test-app.js";
import type { TestAppHarness } from "../helpers/test-app.js";

async function setupEventRoute() {
  const harness = await createTestAppHarness();
  const { host, session } = seedHostSession(harness.deps, {});
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
  });
  const thread = seedThread(harness.deps, {
    projectId: project.id,
    environmentId: environment.id,
    status: "active",
  });
  return { harness, session, thread };
}

async function postEventBatch(args: {
  harness: TestAppHarness;
  sessionId: string;
  events: HostDaemonEventEnvelope[];
}): Promise<void> {
  const response = await args.harness.app.request("/internal/session/events", {
    method: "POST",
    headers: internalAuthHeaders(args.harness),
    body: JSON.stringify({
      sessionId: args.sessionId,
      eventGroups: groupHostDaemonEvents(args.events),
    }),
  });
  expect(response.status).toBe(200);
}

async function readExecuted(harness: TestAppHarness, threadId: string) {
  const response = await harness.app.request(
    `/api/v1/threads/${threadId}/execution-profile`,
  );
  expect(response.status).toBe(200);
  return threadExecutionProfileResponseSchema.parse(await readJson(response))
    .executed;
}

describe("executed in the thread execution profile (get-bb/bb#1787)", () => {
  it("stores what a daemon reports and returns the latest report", async () => {
    const { harness, session, thread } = await setupEventRoute();
    try {
      await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: thread.id,
            event: {
              type: "thread/execution/reported",
              threadId: thread.id,
              scope: threadScope(),
              providerThreadId: "codex-session",
              execution: {
                model: "gpt-5.5",
                reasoningLevel: "medium",
                permissionMode: "auto",
                serviceTier: "default",
              },
            },
          },
          {
            threadId: thread.id,
            event: {
              type: "thread/execution/reported",
              threadId: thread.id,
              scope: threadScope(),
              providerThreadId: "codex-session",
              execution: {
                model: "gpt-5.6-sol",
                reasoningLevel: "xhigh",
                permissionMode: "full",
                serviceTier: null,
              },
            },
          },
        ],
      });

      expect(await readExecuted(harness, thread.id)).toEqual({
        model: "gpt-5.6-sol",
        reasoningLevel: "xhigh",
        permissionMode: "full",
        serviceTier: null,
        reportedAt: expect.any(Number),
      });
      expect(
        harness.db
          .select({ id: events.id })
          .from(events)
          .where(eq(events.type, "thread/execution/reported"))
          .all(),
      ).toEqual([]);
      const eventLog = await harness.app.request(
        `/api/v1/threads/${thread.id}/events`,
      );
      expect(eventLog.status).toBe(200);
    } finally {
      await harness.cleanup();
    }
  });

  it("stays null for a daemon that never reports, such as a stock one", async () => {
    const { harness, session, thread } = await setupEventRoute();
    try {
      await postEventBatch({
        harness,
        sessionId: session.id,
        events: [
          {
            threadId: thread.id,
            event: {
              type: "turn/started",
              threadId: thread.id,
              scope: turnScope("turn-stock-daemon"),
              providerThreadId: "codex-session",
            },
          },
        ],
      });

      expect(await readExecuted(harness, thread.id)).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });

  it("does not store a report when another event makes the batch fail", async () => {
    const { harness, session, thread } = await setupEventRoute();
    try {
      const response = await harness.app.request("/internal/session/events", {
        method: "POST",
        headers: internalAuthHeaders(harness),
        body: JSON.stringify({
          sessionId: session.id,
          eventGroups: groupHostDaemonEvents([
            {
              threadId: thread.id,
              event: {
                type: "thread/execution/reported",
                threadId: thread.id,
                scope: threadScope(),
                providerThreadId: "codex-session",
                execution: {
                  model: "gpt-5.6-sol",
                  reasoningLevel: "high",
                  permissionMode: "full",
                  serviceTier: null,
                },
              },
            },
            {
              threadId: thread.id,
              event: {
                type: "turn/completed",
                threadId: thread.id,
                providerThreadId: "codex-session",
                scope: turnScope("turn-without-start"),
                status: "completed",
              },
            },
          ]),
        }),
      });

      expect(response.status).toBe(409);
      expect(await readExecuted(harness, thread.id)).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });
});
