import { describe, expect, it } from "vitest";
import type { ProjectGroup } from "../../shared/preferences.js";
import { parsePreferenceValue } from "../../shared/preferences.js";
import { getProjectComparator } from "../list/projectSort.js";
import type { SidebarSectionId } from "./sidebar-section-id.js";
import {
  assignProjectToGroup,
  createProjectGroup,
  deleteProjectGroup,
  flattenProjectGroupLayout,
  layoutProjectGroups,
  renameProjectGroup,
  resolveProjectGroupReorder,
  sortProjectGroupLayout,
} from "./project-groups.js";

const work: ProjectGroup = { id: "work", name: "Work", projectIds: ["b", "d"] };
const bb: ProjectGroup = { id: "bb", name: "bb", projectIds: ["c"] };

describe("layoutProjectGroups", () => {
  it("pulls group members together at the first member's position", () => {
    const order: SidebarSectionId[] = [
      "pinned",
      "project:a",
      "project:b",
      "project:c",
      "project:d",
      "threads",
    ];
    expect(layoutProjectGroups(order, [work, bb])).toEqual([
      { kind: "section", sectionId: "pinned" },
      { kind: "section", sectionId: "project:a" },
      { kind: "group", group: work, sectionIds: ["project:b", "project:d"] },
      { kind: "group", group: bb, sectionIds: ["project:c"] },
      { kind: "section", sectionId: "threads" },
    ]);
  });

  it("omits groups whose projects are not in the visible order", () => {
    expect(layoutProjectGroups(["project:a"], [work])).toEqual([
      { kind: "section", sectionId: "project:a" },
    ]);
  });
});

describe("flattenProjectGroupLayout", () => {
  it("keeps members contiguous and drops collapsed group members", () => {
    const layout = layoutProjectGroups(
      ["project:b", "project:a", "project:c", "project:d"],
      [work, bb],
    );
    expect(flattenProjectGroupLayout(layout, new Set())).toEqual([
      "project:b",
      "project:d",
      "project:a",
      "project:c",
    ]);
    expect(flattenProjectGroupLayout(layout, new Set(["work"]))).toEqual([
      "project:a",
      "project:c",
    ]);
  });
});

describe("sortProjectGroupLayout", () => {
  const projects = new Map(
    [
      { id: "a", name: "Alpha", lastActivityAt: 10 },
      { id: "b", name: "Zulu", lastActivityAt: 50 },
      { id: "c", name: "Charlie", lastActivityAt: null },
      { id: "d", name: "Delta", lastActivityAt: 5 },
    ].map((project) => [
      `project:${project.id}` as SidebarSectionId,
      project,
    ]),
  );
  const layout = layoutProjectGroups(
    ["pinned", "project:a", "project:b", "project:c", "project:d", "threads"],
    [work, bb],
  );

  it("sorts groups by name among ungrouped projects alphabetically", () => {
    const sorted = sortProjectGroupLayout(
      layout,
      projects,
      getProjectComparator("alpha", "default"),
    );
    expect(
      sorted.map((entry) =>
        entry.kind === "group" ? entry.group.name : entry.sectionId,
      ),
    ).toEqual(["pinned", "project:a", "bb", "Work", "threads"]);
  });

  it("sorts groups by their most recent member activity", () => {
    const sorted = sortProjectGroupLayout(
      layout,
      projects,
      getProjectComparator("activity", "default"),
    );
    expect(
      sorted.map((entry) =>
        entry.kind === "group" ? entry.group.name : entry.sectionId,
      ),
    ).toEqual(["pinned", "Work", "project:a", "bb", "threads"]);
  });
});

describe("resolveProjectGroupReorder", () => {
  const previous: SidebarSectionId[] = [
    "pinned",
    "project:a",
    "project:b",
    "project:d",
    "project:e",
    "threads",
  ];

  it("reorders members within their group", () => {
    const next: SidebarSectionId[] = [
      "pinned",
      "project:a",
      "project:d",
      "project:b",
      "project:e",
      "threads",
    ];
    expect(resolveProjectGroupReorder(previous, next, [work])).toEqual(next);
  });

  it("moves the whole group when a member is dragged down past a project", () => {
    expect(
      resolveProjectGroupReorder(
        previous,
        [
          "pinned",
          "project:a",
          "project:d",
          "project:e",
          "project:b",
          "threads",
        ],
        [work],
      ),
    ).toEqual([
      "pinned",
      "project:a",
      "project:e",
      "project:b",
      "project:d",
      "threads",
    ]);
  });

  it("moves the whole group when a member is dragged up past a project", () => {
    expect(
      resolveProjectGroupReorder(
        previous,
        [
          "pinned",
          "project:d",
          "project:a",
          "project:b",
          "project:e",
          "threads",
        ],
        [work],
      ),
    ).toEqual([
      "pinned",
      "project:b",
      "project:d",
      "project:a",
      "project:e",
      "threads",
    ]);
  });

  it("leaves ungrouped moves unchanged", () => {
    const next: SidebarSectionId[] = [
      "pinned",
      "project:b",
      "project:d",
      "project:a",
      "project:e",
      "threads",
    ];
    expect(resolveProjectGroupReorder(previous, next, [work])).toEqual(next);
  });
});

describe("project group edits", () => {
  it("moves a project between groups and drops groups left empty", () => {
    expect(assignProjectToGroup([work, bb], "c", "work")).toEqual([
      { ...work, projectIds: ["b", "d", "c"] },
    ]);
  });

  it("removes a project from its group", () => {
    expect(assignProjectToGroup([work, bb], "b", null)).toEqual([
      { ...work, projectIds: ["d"] },
      bb,
    ]);
  });

  it("keeps a sole member in its own group when reassigned to it", () => {
    expect(assignProjectToGroup([work, bb], "c", "bb")).toEqual([work, bb]);
  });

  it("creates a group that takes its projects from other groups", () => {
    const personal = { id: "p", name: "Personal", projectIds: ["c"] };
    expect(createProjectGroup([work, bb], personal)).toEqual([work, personal]);
  });

  it("renames and deletes groups", () => {
    expect(renameProjectGroup([work, bb], "bb", "bb dev")).toEqual([
      work,
      { ...bb, name: "bb dev" },
    ]);
    expect(deleteProjectGroup([work, bb], "work")).toEqual([bb]);
  });
});

describe("projectGroups preference", () => {
  it("rejects a project in two groups", () => {
    const result = parsePreferenceValue("projectGroups", [
      work,
      { id: "other", name: "Other", projectIds: ["b"] },
    ]);
    expect(result).toEqual({
      success: false,
      message: "A project can belong to only one project group.",
    });
  });

  it("rejects duplicate group ids and blank names", () => {
    expect(
      parsePreferenceValue("projectGroups", [work, { ...bb, id: "work" }])
        .success,
    ).toBe(false);
    expect(
      parsePreferenceValue("projectGroups", [{ ...bb, name: "  " }]).success,
    ).toBe(false);
  });

  it("trims group names", () => {
    expect(
      parsePreferenceValue("projectGroups", [{ ...bb, name: " bb " }]),
    ).toEqual({ success: true, value: [bb] });
  });
});
