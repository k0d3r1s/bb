import { describe, expect, it } from "vitest";
import { getThreadExecutionReport, upsertThreadExecutionReport } from "../../src/data/thread-execution-reports.js";
import { upsertHost } from "../../src/data/hosts.js";
import { createProject } from "../../src/data/projects.js";
import { createThread, deleteThread } from "../../src/data/threads.js";
import { noopNotifier } from "../../src/notifier.js";
import { createMigratedConnection } from "../helpers/migrated-connection.js";

describe("thread execution reports", () => {
  it("deletes a report when its thread is deleted", () => {
    const db = createMigratedConnection();
    const host = upsertHost(db, noopNotifier, { name: "test-host" });
    const { project } = createProject(db, noopNotifier, {
      name: "test-project",
      source: { type: "local_path", hostId: host.id, path: "/tmp/test" },
    });
    const thread = createThread(db, noopNotifier, {
      projectId: project.id,
      providerId: "codex",
    });

    upsertThreadExecutionReport(db, {
      threadId: thread.id,
      execution: {
        model: "gpt-5",
        reasoningLevel: null,
        permissionMode: null,
        serviceTier: null,
      },
      reportedAt: 1,
    });

    expect(deleteThread(db, noopNotifier, thread.id)).toBe(true);
    expect(getThreadExecutionReport(db, thread.id)).toBeNull();
  });
});
