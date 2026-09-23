// @vitest-environment jsdom
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { makeTask } from "../../test-fixtures.js";
import type { Task } from "../../shared/contract.js";

const app = await loadPluginApp(() => import("../../app"));
const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const PARENT_ID = "01HZZZZZZZZZZZZZZZZZZZZZT1";
const SUBTASK_ID = "01HZZZZZZZZZZZZZZZZZZZZZT2";
const ARCHIVED_AT = "2026-09-15T00:00:00.000Z";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const parent = makeTask({
  id: PARENT_ID,
  projectId: PROJECT_ID,
  key: "OPS-1",
  title: "Archived parent",
  status: "done",
  closedAt: "2026-09-08T00:00:00.000Z",
  archivedAt: ARCHIVED_AT,
});

const subtask = makeTask({
  id: SUBTASK_ID,
  projectId: PROJECT_ID,
  number: 2,
  key: "OPS-2",
  title: "Archived child",
  status: "done",
  parentTaskId: PARENT_ID,
  closedAt: "2026-09-08T00:00:00.000Z",
  archivedAt: ARCHIVED_AT,
});

function detailRpc() {
  const calls: { method: string; input: unknown }[] = [];
  const byId = new Map<string, Task>([
    [PARENT_ID, parent],
    [SUBTASK_ID, subtask],
  ]);
  return {
    calls,
    handlers: {
      listProjects: () => ({
        projects: [
          {
            id: PROJECT_ID,
            name: "Operating",
            prefix: "OPS",
            nextTaskNumber: 3,
            color: "blue",
            folderId: null,
            linkedBbProjectId: null,
            createdAt: "2026-09-01T00:00:00.000Z",
          },
        ],
      }),
      getTaskByKey: (input: unknown) => ({
        task:
          (input as { taskKey: string }).taskKey === parent.key
            ? parent
            : subtask,
      }),
      getTask: (input: unknown) => ({
        task: byId.get((input as { taskId: string }).taskId) ?? null,
      }),
      listTasks: (input: unknown) => {
        calls.push({ method: "listTasks", input });
        const filters = input as {
          parentTaskId?: string | null;
          archive?: string;
        };
        const archiveVisible =
          filters.archive === "all" || filters.archive === "archived";
        return {
          tasks:
            filters.parentTaskId === PARENT_ID && archiveVisible
              ? [subtask]
              : [],
          nextCursor: null,
        };
      },
      listLabels: () => ({ labels: [] }),
      listPresets: () => ({ presets: [] }),
      listAttachments: () => ({ attachments: [] }),
      listComments: () => ({ comments: [] }),
      listTaskThreads: () => ({ taskThreads: [] }),
      listTaskPullRequests: () => ({
        pullRequests: [],
        unavailableThreadIds: [],
      }),
      restoreTasks: (input: unknown) => {
        calls.push({ method: "restoreTasks", input });
        return { tasks: [{ ...parent, archivedAt: null }] };
      },
    },
  };
}

describe("archived task detail", () => {
  it("shows an archived parent with its sub-tasks and a Restore action", async () => {
    const fixture = detailRpc();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: `task/${parent.key}` },
      { rpc: fixture.handlers },
    );

    await slot.findByText("Archived parent");
    await slot.findByText(
      "Archived. Restore it to change its status or position.",
    );
    await waitFor(() => expect(slot.getByText("OPS-2")).toBeDefined());
    expect(
      fixture.calls.filter(
        (call) =>
          call.method === "listTasks" &&
          (call.input as { parentTaskId?: string }).parentTaskId === PARENT_ID,
      ),
    ).toContainEqual(
      expect.objectContaining({
        input: expect.objectContaining({ archive: "all" }),
      }),
    );

    fireEvent.click(slot.getByRole("button", { name: "Restore" }));
    await waitFor(() =>
      expect(fixture.calls).toContainEqual({
        method: "restoreTasks",
        input: {
          projectId: PROJECT_ID,
          taskIds: [PARENT_ID],
          authorName: "You",
        },
      }),
    );
  });

  it("points an archived sub-task at its parent to restore", async () => {
    const fixture = detailRpc();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: `task/${subtask.key}` },
      { rpc: fixture.handlers },
    );

    await slot.findByText("Archived child");
    await slot.findByText(
      `Archived with its parent ${parent.key}. Restore the parent to change this sub-task.`,
    );

    fireEvent.click(
      await slot.findByRole("button", { name: `Restore ${parent.key}` }),
    );
    await waitFor(() =>
      expect(fixture.calls).toContainEqual({
        method: "restoreTasks",
        input: {
          projectId: PROJECT_ID,
          taskIds: [PARENT_ID],
          authorName: "You",
        },
      }),
    );
  });
});
