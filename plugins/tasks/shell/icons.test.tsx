// @vitest-environment jsdom
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { isBuiltinIconName } from "@bb/shared-ui/icon";

const app = await loadPluginApp(() => import("../app"));
const pluginDir = dirname(dirname(fileURLToPath(import.meta.url)));
const PROJECT_ID = "01HZZZZZZZZZZZZZZZZZZZZZP1";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : sourceFiles(path);
    }
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
      ? [path]
      : [];
  });
}

const ICON_PROP_PATTERNS = [
  /<Icon\b[^>]*?\sname=(\{[^}]*\}|"[^"]*")/gs,
  /\bicon(?:=|:\s)\s*(\{[^}]*\}|"[^"]*")/g,
  /\bfallback=(\{[^}]*\}|"[^"]*")/g,
];

function iconNamesIn(source: string): string[] {
  const names: string[] = [];
  for (const pattern of ICON_PROP_PATTERNS) {
    for (const match of source.matchAll(pattern)) {
      for (const literal of match[1]!.matchAll(/"([^"]*)"/g)) {
        const name = literal[1]!;
        if (/^[A-Z][A-Za-z0-9]*$/.test(name)) names.push(name);
      }
    }
  }
  return names;
}

describe("tasks icon names", () => {
  it("only references icons the shared registry can resolve", () => {
    const unregistered = new Map<string, string[]>();
    let checked = 0;
    for (const file of sourceFiles(pluginDir)) {
      for (const name of iconNamesIn(readFileSync(file, "utf8"))) {
        checked += 1;
        if (isBuiltinIconName(name)) continue;
        const files = unregistered.get(name) ?? [];
        files.push(file.slice(pluginDir.length + 1));
        unregistered.set(name, files);
      }
    }

    expect(checked).toBeGreaterThan(30);
    expect(Object.fromEntries(unregistered)).toEqual({});
  });

  it("renders the Recently closed entries with registered artwork", async () => {
    const tasksRegistration = app.navPanels[0]!;
    const navigation = tasksRegistration.fixedTabs?.[0]!;
    const slot = renderSlot(
      { ...tasksRegistration, component: navigation.component },
      { subPath: "all" },
      {
        rpc: {
          listProjects: () => ({ projects: [] }),
          listFolders: () => ({ folders: [] }),
          sidebarSummary: () => ({ projects: [] }),
          sidebarOpenTaskCount: () => ({ openTaskCount: 0 }),
          listTasks: () => ({ tasks: [], nextCursor: null }),
        },
      },
    );

    const row = await slot.findByText("Recently closed");
    const icon = row.parentElement?.querySelector("svg[data-icon]");
    expect(icon?.getAttribute("data-icon")).toBe("TimeSchedule");
    await act(async () => {
      await waitFor(() =>
        expect(
          row.parentElement?.querySelector("svg[data-icon=TimeSchedule]")
            ?.childElementCount ?? 0,
        ).toBeGreaterThan(0),
      );
    });
  });

  it("renders the Recently closed empty state with registered artwork", async () => {
    const slot = renderSlot(
      app.navPanels[0]!,
      { subPath: `recent/${PROJECT_ID}` },
      {
        rpc: {
          listProjects: () => ({
            projects: [
              {
                id: PROJECT_ID,
                name: "Operating",
                prefix: "OPS",
                nextTaskNumber: 1,
                color: "blue",
                folderId: null,
                linkedBbProjectId: null,
                createdAt: "2026-09-14T00:00:00.000Z",
              },
            ],
          }),
          listTasks: () => ({ tasks: [], nextCursor: null }),
          listLabels: () => ({ labels: [] }),
          listTaskThreads: () => ({ taskThreads: [] }),
        },
      },
    );

    await slot.findByText("No recently closed tasks");
    expect(
      slot.container.querySelector("svg[data-icon=TimeSchedule]"),
    ).not.toBeNull();
    expect(slot.container.querySelector("svg[data-icon=Zap]")).toBeNull();
  });
});
