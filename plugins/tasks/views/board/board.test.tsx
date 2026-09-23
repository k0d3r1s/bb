// @vitest-environment jsdom
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { makeTask } from "../../test-fixtures.js";
import type { Task, TaskStatus } from "../../shared/contract.js";

const app = await loadPluginApp(() => import("../../app"));
const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const PARENT_ID = "01HZZZZZZZZZZZZZZZZZZZZZT1";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function subtask(suffix: string, status: TaskStatus): Task {
  return makeTask({
    id: `01HZZZZZZZZZZZZZZZZZZZZZS${suffix}`,
    projectId: PROJECT_ID,
    number: Number(suffix) + 1,
    key: `OPS-${Number(suffix) + 1}`,
    title: `Sub-task ${suffix}`,
    status,
    parentTaskId: PARENT_ID,
  });
}

function boardRpc() {
  const listTaskInputs: unknown[] = [];
  const tasks: Task[] = [
    makeTask({
      id: PARENT_ID,
      projectId: PROJECT_ID,
      key: "OPS-1",
      title: "Parent on the board",
      status: "in_progress",
    }),
    subtask("1", "done"),
    subtask("2", "done"),
    subtask("3", "in_progress"),
    makeTask({
      id: "01HZZZZZZZZZZZZZZZZZZZZZT9",
      projectId: PROJECT_ID,
      number: 9,
      key: "OPS-9",
      title: "Closed top-level work",
      status: "done",
      closedAt: "2026-09-14T00:00:00.000Z",
    }),
  ];
  return {
    listTaskInputs,
    handlers: {
      listProjects: () => ({
        projects: [
          {
            id: PROJECT_ID,
            name: "Operating",
            prefix: "OPS",
            nextTaskNumber: 10,
            color: "blue",
            folderId: null,
            linkedBbProjectId: null,
            createdAt: "2026-09-14T00:00:00.000Z",
          },
        ],
      }),
      listTasks: (input: unknown) => {
        listTaskInputs.push(input);
        const filters = input as {
          statuses?: readonly TaskStatus[];
          parentTaskId?: string | null;
          activeOnly?: boolean;
        };
        if (filters.activeOnly === true) return { tasks: [], nextCursor: null };
        return {
          tasks: tasks.filter(
            (task) =>
              (filters.statuses === undefined ||
                filters.statuses.includes(task.status)) &&
              (filters.parentTaskId === undefined ||
                task.parentTaskId === filters.parentTaskId),
          ),
          nextCursor: null,
        };
      },
      listLabels: () => ({ labels: [] }),
      listAttachments: () => ({ attachments: [] }),
      listTaskThreads: () => ({ taskThreads: [] }),
    },
  };
}

describe("board sub-task progress", () => {
  it("counts completed sub-tasks even though the board fetches actionable parents", async () => {
    const fixture = boardRpc();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: `${PROJECT_ID}?view=board` },
      { rpc: fixture.handlers },
    );

    await slot.findByText("Parent on the board");
    expect(await slot.findByText("2/3")).toBeDefined();
  });

  it("keeps terminal work off the board without a query per card", async () => {
    const fixture = boardRpc();
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: `${PROJECT_ID}?view=board` },
      { rpc: fixture.handlers },
    );

    await slot.findByText("Parent on the board");
    expect(slot.queryByText("Closed top-level work")).toBeNull();
    expect(slot.queryByText("Sub-task 1")).toBeNull();
    expect(
      fixture.listTaskInputs.filter(
        (input) =>
          typeof input === "object" &&
          input !== null &&
          (input as { parentTaskId?: unknown }).parentTaskId !== undefined,
      ),
    ).toEqual([]);
  });
});
