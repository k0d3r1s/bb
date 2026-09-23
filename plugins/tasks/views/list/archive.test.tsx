// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Task } from "../../shared/contract.js";
import { makeTask } from "../../test-fixtures.js";

const app = await loadPluginApp(() => import("../../app"));
const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";
const TASK_ID = "01HZZZZZZZZZZZZZZZZZZZZZT1";
const SECOND_TASK_ID = "01HZZZZZZZZZZZZZZZZZZZZZT2";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function rpc(taskMode: "recent" | "archive", includeTask = true) {
  const calls: { method: string; input: unknown }[] = [];
  const task = makeTask({
    id: TASK_ID,
    projectId: PROJECT_ID,
    key: "OPS-1",
    status: "done",
    closedAt: "2026-09-14T00:00:00.000Z",
    archivedAt: taskMode === "archive" ? "2026-09-14T01:00:00.000Z" : null,
  });
  return {
    calls,
    handlers: {
      listProjects: () => ({
        projects: [
          {
            id: PROJECT_ID,
            name: "Operating",
            prefix: "OPS",
            nextTaskNumber: 2,
            color: "blue",
            folderId: null,
            linkedBbProjectId: null,
            createdAt: "2026-09-14T00:00:00.000Z",
          },
        ],
      }),
      listTasks: (input: unknown) => {
        calls.push({ method: "listTasks", input });
        return { tasks: includeTask ? [task] : [], nextCursor: null };
      },
      listLabels: () => ({ labels: [] }),
      listTaskThreads: () => ({ taskThreads: [] }),
      archiveTasks: (input: unknown) => {
        calls.push({ method: "archiveTasks", input });
        return { tasks: [{ ...task, archivedAt: "2026-09-14T02:00:00.000Z" }] };
      },
      restoreTasks: (input: unknown) => {
        calls.push({ method: "restoreTasks", input });
        return { tasks: [{ ...task, archivedAt: null }] };
      },
    },
  };
}

describe("task archive views", () => {
  it("archives selected recently closed tasks within the routed project", async () => {
    const fixture = rpc("recent");
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: `recent/${PROJECT_ID}` },
      { rpc: fixture.handlers },
    );

    fireEvent.click(
      await slot.findByRole("checkbox", { name: "Select OPS-1" }),
    );
    fireEvent.click(slot.getByRole("button", { name: "Archive completed" }));

    expect(fixture.calls).toContainEqual({
      method: "archiveTasks",
      input: { projectId: PROJECT_ID, taskIds: [TASK_ID], authorName: "You" },
    });
  });

  it("restores selected archived tasks without changing their status", async () => {
    const fixture = rpc("archive");
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: `archive/${PROJECT_ID}` },
      { rpc: fixture.handlers },
    );

    fireEvent.click(
      await slot.findByRole("checkbox", { name: "Select OPS-1" }),
    );
    fireEvent.click(slot.getByRole("button", { name: "Restore" }));

    expect(fixture.calls).toContainEqual({
      method: "restoreTasks",
      input: { projectId: PROJECT_ID, taskIds: [TASK_ID], authorName: "You" },
    });
  });

  it("drops selected tasks that leave the list from the count and the request", async () => {
    const fixture = rpc("recent");
    const second = makeTask({
      id: SECOND_TASK_ID,
      projectId: PROJECT_ID,
      number: 2,
      key: "OPS-2",
      status: "canceled",
      closedAt: "2026-09-14T00:00:00.000Z",
    });
    let visible: Task[] = [
      makeTask({
        id: TASK_ID,
        projectId: PROJECT_ID,
        key: "OPS-1",
        status: "done",
        closedAt: "2026-09-14T00:00:00.000Z",
      }),
      second,
    ];
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: `recent/${PROJECT_ID}` },
      {
        rpc: {
          ...fixture.handlers,
          listTasks: () => ({ tasks: visible, nextCursor: null }),
        },
      },
    );

    fireEvent.click(
      await slot.findByRole("checkbox", { name: "Select OPS-1" }),
    );
    fireEvent.click(slot.getByRole("checkbox", { name: "Select OPS-2" }));
    expect(slot.getByText("2 selected")).toBeDefined();

    visible = [second];
    await slot.behavior.emitRealtime("tasks:changed", {
      taskId: TASK_ID,
      projectId: PROJECT_ID,
    });
    await waitFor(() => expect(slot.getByText("1 selected")).toBeDefined());

    fireEvent.click(slot.getByRole("button", { name: "Archive completed" }));
    await waitFor(() =>
      expect(fixture.calls).toContainEqual({
        method: "archiveTasks",
        input: {
          projectId: PROJECT_ID,
          taskIds: [SECOND_TASK_ID],
          authorName: "You",
        },
      }),
    );
  });

  it("clears selections hidden by a status filter", async () => {
    const fixture = rpc("recent");
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: `recent/${PROJECT_ID}` },
      { rpc: fixture.handlers },
    );

    fireEvent.click(
      await slot.findByRole("checkbox", { name: "Select OPS-1" }),
    );
    expect(slot.getByText("1 selected")).toBeDefined();

    fireEvent.keyDown(slot.getByRole("button", { name: /^Status/ }), {
      key: "Enter",
    });
    fireEvent.click(
      await slot.findByRole("menuitemcheckbox", { name: "Canceled" }),
    );
    await waitFor(() => expect(slot.getByText("0 selected")).toBeDefined());
    expect(
      slot
        .getByText("Archive completed")
        .closest("button")
        ?.hasAttribute("disabled"),
    ).toBe(true);
  });

  it("sends one archive request while a previous one is pending", async () => {
    const fixture = rpc("recent");
    let finish: () => void = () => {};
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: `recent/${PROJECT_ID}` },
      {
        rpc: {
          ...fixture.handlers,
          archiveTasks: (input: unknown) => {
            fixture.calls.push({ method: "archiveTasks", input });
            return new Promise((resolve) => {
              finish = () => resolve({ tasks: [] });
            });
          },
        },
      },
    );

    fireEvent.click(
      await slot.findByRole("checkbox", { name: "Select OPS-1" }),
    );
    const button = slot.getByRole("button", { name: "Archive completed" });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(true));
    fireEvent.click(button);

    expect(
      fixture.calls.filter((call) => call.method === "archiveTasks"),
    ).toHaveLength(1);
    await act(async () => finish());
  });

  it("explains empty Recent and Archive views without offering new work", async () => {
    const recent = renderSlot(
      app.navPanels[0]!,
      { subPath: `recent/${PROJECT_ID}` },
      { rpc: rpc("recent", false).handlers },
    );
    await recent.findByText("No recently closed tasks");
    expect(recent.queryByRole("button", { name: "New task" })).toBeNull();
    recent.lifecycle.unmount();

    const archive = renderSlot(
      app.navPanels[0]!,
      { subPath: `archive/${PROJECT_ID}` },
      { rpc: rpc("archive", false).handlers },
    );
    await archive.findByText("Archive is empty");
    expect(archive.queryByRole("button", { name: "New task" })).toBeNull();
  });
});
